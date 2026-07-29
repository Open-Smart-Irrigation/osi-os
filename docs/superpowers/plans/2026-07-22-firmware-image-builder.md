# Firmware Image Builder Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
**Goal:** Build a local, durable OSI firmware image builder that pins one fetched `origin` commit, builds one Raspberry Pi target in an isolated worktree, verifies release evidence, and publishes an immutable image through a fail-closed React console.
**Architecture:** A Node >=22 TypeScript package under `tools/firmware-image-builder` owns the local API, SQLite store, queue dispatcher, runner, cleanup worker, manifest, and UI. The runner is started by an independent user-level systemd template and executes every repository operation in a complete tool-owned digest-pinned Docker builder. A small C17 helper and production TypeScript client own no-follow directory walking, fsync, and `renameat2(RENAME_NOREPLACE)` publication; SQLite remains the authority for state, transitions, leases, evidence indexes, and recovery fences.
**Tech Stack:** Node.js >=22 with `node:sqlite` `DatabaseSync`, TypeScript, `tsx`, Vitest, Node `http`, React 18, Vite, `lucide-react`, Playwright, Docker CLI, user systemd, C17/GCC, and Linux `renameat2`.

---

## Implementation rules

Workers must run each task in this worktree and must keep changes inside the
files listed by that task. The existing active checkout is never switched,
reset, cleaned, or used as a build worktree. Every task follows one red-green
loop: write the named failing test, run the exact command in Step 2, implement
the smallest code satisfying the cited spec clauses, run the identical command
in Step 4, then make the listed commit. A task is ready for Sol review only
when its named command passes and the worker reports the command output.

All TypeScript tests use Vitest or `tsx`; no TypeScript test uses Node's native
test runner. Every Step 2 and Step 4 command executes every test file that its
task creates or modifies. Tests use fake Git, Docker, systemd, clocks, command
executors, and filesystems unless a task explicitly names a workstation or
real-image boundary.

Every integration test file executes on every host. `test.skip`,
`describe.skip`, `it.skip`, deferred-case markers, host-conditional silent returns, and
environment-based test omission are forbidden. Native publisher, Docker,
systemd, host-probe, and installer integration tests report a typed
`available: false` prerequisite result and assert zero mutation when the host
cannot provide the capability; they do not skip or pass without assertions.
Guarded real commands are different: a missing prerequisite or approval causes
a nonzero exit. Docker is a required real-acceptance prerequisite, not an
required real-acceptance capability.

| Test class | Command | Boundary |
| --- | --- | --- |
| Unit | `npm run test:unit` | Fake external processes and temporary SQLite state. |
| Package integration | `npm run test:integration` | Temporary state/output roots, fixture Git repositories, native publisher, fake Docker, and fake systemd. |
| Browser | `npm run test:browser` | Loopback same-origin fixture API plus Vite web server and Playwright. |
| Workstation | `npm run test:workstation` | Three deterministic prerequisite/guard tests; unsupported-host results are typed and the process passes with zero mutation. |
| Real acceptance | `npm run accept:all` | Real SSH `origin`, Docker, user systemd, generated installed lock/image, approved output root, and both sequential Pi image builds. Any nonzero result blocks completion and commit. |

The approved design is at `docs/superpowers/specs/2026-07-22-firmware-image-builder-design.md`. The existing manual build contract is at `docs/build/rpi5-full-osi-image.md`. For TypeScript under `web/react-gui`, read `architect.yaml`, `RULES.yaml`, and `docs/agents/typescript-rule-overlays.md`; the new builder UI is under `tools/firmware-image-builder/ui` and follows the same behavior-first test standard.

## Files and ownership map

The implementation uses these concrete paths. No build state is added to
`flows.json`, the Pi image, or the edge runtime. No production builder lock is
committed in the repository. The only committed lock fixture is explicitly
non-installable and is used to test rejection.

```text
tools/firmware-image-builder/
  package.json
  package-lock.json
  tsconfig.json
  vitest.config.ts
  playwright.config.ts
  README.md
  manifest/targets.json
  manifest/schema.ts
  manifest/validate.ts
  config/defaults.ts
  config/load.ts
  domain/types.ts
  domain/errors.ts
  domain/states.ts
  domain/paths.ts
  test/fakes.ts
  test/fixtures/builder/non-installable-lock.json
  api/migrations/001_initial.sql
  api/migrations/002_recovery.sql
  api/migrations/003_freshness_and_logs.sql
  api/src/store.ts
  api/src/ownership.ts
  api/src/git/git-command.ts
  api/src/git/source-resolver.ts
  api/src/preflight.ts
  api/src/cancellation.ts
  api/src/queue.ts
  api/src/recovery.ts
  api/src/health.ts
  api/src/retention.ts
  api/src/log-stream.ts
  api/src/routes.ts
  api/src/server.ts
  api/src/static-ui.ts
  api/src/startup-order.ts
  api/src/main.ts
  runner/src/command-executor.ts
  runner/src/docker-executor.ts
  runner/src/operation-registry.ts
  runner/src/evidence.ts
  runner/src/source.ts
  runner/src/target-setup.ts
  runner/src/verification.ts
  runner/src/pipeline.ts
  runner/src/cancellation.ts
  runner/src/publisher-client.ts
  runner/src/main.ts
  cleanup-worker/src/main.ts
  publisher/osi-image-publish.c
  publisher/Makefile
  publisher/test-publisher.sh
  publisher/client.ts
  builder/Dockerfile
  builder/builder-lock.schema.json
  builder/derive-dockerfile.ts
  builder/validate-builder.ts
  builder/validate-rust-toolchain.ts
  builder/execution-definition.json
  installer/probe-host.c
  installer/probe-renameat2.c
  installer/install.ts
  installer/configure.ts
  systemd/osi-image-builder.service
  systemd/osi-image-builder-runner@.service
  systemd/osi-image-builder-cleanup@.service
  ui/index.html
  ui/vite.config.ts
  ui/src/main.tsx
  ui/src/App.tsx
  ui/src/api.ts
  ui/src/types.ts
  ui/src/styles.css
  ui/src/components/BuildForm.tsx
  ui/src/components/QueueTable.tsx
  ui/src/components/JobDetail.tsx
  ui/src/components/StatusBadge.tsx
  ui/src/__tests__/BuildForm.test.tsx
  ui/src/__tests__/QueueTable.test.tsx
  ui/src/__tests__/JobDetail.test.tsx
  test/unit/*.test.ts
  test/integration/*.test.ts
  test/browser/fixture-server.ts
  test/browser/builder.spec.ts
  test/browser/overlap.ts
  test/browser/screenshots/builder-desktop.png
  test/browser/screenshots/builder-mobile.png
  scripts/require-node22.mjs
  scripts/check-plan-policy.mjs
  scripts/run-workstation-test.mjs
  scripts/accept-real-target.mjs
```

`api/` owns configuration, HTTP, Git fetch and SHA resolution, queue fields,
cancellation coordination, cleanup admissions, recovery terminals, and SQLite
reads. `runner/` owns normal stage and terminal transitions, Docker identity,
operation execution, evidence, verification, cooperative cancellation, and
publication requests. `cleanup-worker/` owns only its admitted cleanup lease,
exact container cleanup, log/staging evidence, and the cleanup-worker CAS clear.
`ui/` calls the same-origin API. `publisher/` is the native helper and trusted
TypeScript client used by the runner and cleanup worker. `builder/` is the only
source of the installed builder image and direct Docker execution definition.

### Task 1: Scaffold the package and test harness

**Files:**
- Create: `tools/firmware-image-builder/package.json`
- Create: `tools/firmware-image-builder/package-lock.json`
- Create: `tools/firmware-image-builder/tsconfig.json`
- Create: `tools/firmware-image-builder/vitest.config.ts`
- Create: `tools/firmware-image-builder/playwright.config.ts`
- Create: `tools/firmware-image-builder/scripts/require-node22.mjs`
- Create: `tools/firmware-image-builder/test/fakes.ts`
- Create: `tools/firmware-image-builder/test/unit/toolchain.test.ts`
- Create: `tools/firmware-image-builder/README.md`

- [ ] **Step 1: Write the failing test.** Add a Vitest test that invokes the package version gate with injected versions `22.4.9`, `22.5.0`, and `23.0.0`, expecting the first to return `NODE_VERSION_UNSUPPORTED` and the latter two to pass. Add a package contract test for ESM, strict TypeScript, `node:sqlite`, and only the early scripts `test:unit`, `test:integration`, and `test:browser`; later tasks add workstation, acceptance, check, and installer scripts.

- [ ] **Step 2: Run the failing test.**

Run: `cd tools/firmware-image-builder && npm install && npm exec vitest run -- test/unit/toolchain.test.ts`

Expected: FAIL because the package, version gate, and test harness do not exist.

- [ ] **Step 3: Implement the scaffold.** Define `engines.node` as `>=22.5.0`, add TypeScript, `tsx`, Vitest, React, Vite, Playwright, testing-library, and `lucide-react`, and configure strict ESM compilation for API, runner, cleanup worker, builder, installer, domain, manifest, and UI sources. Make the three early scripts invoke the existing `scripts/require-node22.mjs`; later scripts must use the same gate. Add typed fake interfaces for Git, Docker, systemd, command execution, clock, filesystem, and publisher calls. Do not define `npm run check` or acceptance scripts in this task.

- [ ] **Step 4: Run the identical command.**

Run: `cd tools/firmware-image-builder && npm install && npm exec vitest run -- test/unit/toolchain.test.ts`

Expected: PASS with the version and package contract tests green.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/package.json tools/firmware-image-builder/package-lock.json tools/firmware-image-builder/tsconfig.json tools/firmware-image-builder/vitest.config.ts tools/firmware-image-builder/playwright.config.ts tools/firmware-image-builder/scripts/require-node22.mjs tools/firmware-image-builder/test/fakes.ts tools/firmware-image-builder/test/unit/toolchain.test.ts tools/firmware-image-builder/README.md
git commit -m "feat: scaffold firmware image builder package"
```

### Task 2: Add configuration loading and approved-root validation

**Files:**
- Create: `tools/firmware-image-builder/config/defaults.ts`
- Create: `tools/firmware-image-builder/config/load.ts`
- Create: `tools/firmware-image-builder/test/unit/config.test.ts`

- [ ] **Step 1: Write the failing test.** Test XDG state/config expansion, absolute repository paths, SSH-only `origin`, approved root IDs, canonical non-symlink writable roots, 20 GiB threshold, max queue length, versioned builder installation path, and rejection of arbitrary submitted output paths or block devices. Assert configuration failure causes zero files to be written.

- [ ] **Step 2: Run the failing test.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/config.test.ts`

Expected: FAIL because config parsing and approved-root validation do not exist.

- [ ] **Step 3: Implement configuration.** Add `loadConfig()` and `validateApprovedRoots()` using `realpath`, `lstat`, owner/writable checks, fixed root IDs, and builder-owned state/quarantine paths. Return canonical paths and a redacted config view. Reject HTTPS/local `origin`, symlinked roots, relative paths, block devices, and root IDs not present in config.

- [ ] **Step 4: Run the identical command.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/config.test.ts`

Expected: PASS with invalid configuration producing typed errors and no mutation.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/config tools/firmware-image-builder/test/unit/config.test.ts
git commit -m "feat: validate builder configuration and output roots"
```

### Task 3: Define domain states, errors, actors, and transitions

**Files:**
- Create: `tools/firmware-image-builder/domain/types.ts`
- Create: `tools/firmware-image-builder/domain/errors.ts`
- Create: `tools/firmware-image-builder/domain/states.ts`
- Create: `tools/firmware-image-builder/test/unit/domain.test.ts`

- [ ] **Step 1: Write the failing test.** Test exhaustive unions for target IDs, stage names, operation IDs, job states, freshness states, cleanup admission states, actor names, and the explicit active recovery set. Test stable error shapes with `code`, `stage`, `details`, `retryable`, and `requestId`, and reject unlisted transitions.

- [ ] **Step 2: Run the failing test.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/domain.test.ts`

Expected: FAIL because domain unions, error constructors, and transition rules do not exist.

- [ ] **Step 3: Implement the domain vocabulary.** Define the exact states and transitions from spec sections 4, 9, and 14. Define `AdmissionId` validation for `^cln_[0-9a-hj-km-np-tv-z]{26}$`, typed operation results, evidence outcomes, freshness results, and actor-owned mutation groups. Keep API, runner, and cleanup-worker ownership explicit in types.

- [ ] **Step 4: Run the identical command.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/domain.test.ts`

Expected: PASS with exhaustive compile-time and runtime domain checks.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/domain tools/firmware-image-builder/test/unit/domain.test.ts
git commit -m "feat: define builder state and error contracts"
```

### Task 4: Add and validate the target manifest

**Files:**
- Create: `tools/firmware-image-builder/manifest/targets.json`
- Create: `tools/firmware-image-builder/manifest/schema.ts`
- Create: `tools/firmware-image-builder/manifest/validate.ts`
- Create: `tools/firmware-image-builder/test/unit/manifest.test.ts`

- [ ] **Step 1: Write the failing test.** Test the exact `rpi-5` and `rpi-2` target values, ten ordered stages, exact typed operation IDs, profile names, target output paths, `14336` rootfs size, 64 MiB floor, runtime file list, and config symbol types. Test rejection of absolute paths, traversal, duplicate IDs, unknown stages/operations, wrong symbol values, missing profiles, wrong partition sizes, and artifact patterns that cannot resolve one factory image.

- [ ] **Step 2: Run the failing test.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/manifest.test.ts`

Expected: FAIL because the manifest and validator do not exist.

- [ ] **Step 3: Implement the manifest.** Copy locked target data from spec section 7. Define `loadManifest()` to validate and freeze the manifest, reject shell text or executable paths in JSON, return its SHA-256, and enforce artifact cardinality during verification rather than treating a glob as proof of one output.

- [ ] **Step 4: Run the identical command.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/manifest.test.ts`

Expected: PASS with both target records accepted and malformed records rejected with stable codes.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/manifest tools/firmware-image-builder/test/unit/manifest.test.ts
git commit -m "feat: add validated Pi target manifest"
```

### Task 5: Create versioned SQLite migrations

**Files:**
- Create: `tools/firmware-image-builder/api/migrations/001_initial.sql`
- Create: `tools/firmware-image-builder/api/migrations/002_recovery.sql`
- Create: `tools/firmware-image-builder/api/migrations/003_freshness_and_logs.sql`
- Create: `tools/firmware-image-builder/api/src/store-schema.ts`
- Create: `tools/firmware-image-builder/test/unit/migrations.test.ts`

- [ ] **Step 1: Write the failing test.** Test migration ordering and idempotence for `schema_migrations`, `jobs`, `queue_entries`, `job_stages`, `job_operations`, `job_events`, and `cleanup_leases`. Assert `ON DELETE RESTRICT`, WAL, foreign keys, busy timeout, ownership columns, cleanup generation/token hashes, event sequence, log ranges, artifact/publish fields, and immutable operation evidence.

- [ ] **Step 2: Run the failing test.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/migrations.test.ts`

Expected: FAIL because migration files and the migration runner do not exist.

- [ ] **Step 3: Implement migrations.** Use `DatabaseSync` from `node:sqlite`, apply ordered SQL in explicit transactions, and configure WAL, foreign keys, and a busy timeout before opening the queue. Make migration drift or an unknown migration fail startup without changing job state.

- [ ] **Step 4: Run the identical command.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/migrations.test.ts`

Expected: PASS with fresh and twice-migrated databases having the same schema and constraints.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/migrations tools/firmware-image-builder/api/src/store-schema.ts tools/firmware-image-builder/test/unit/migrations.test.ts
git commit -m "feat: add versioned builder database schema"
```

### Task 6: Implement the SQLite store and atomic event writes

**Files:**
- Create: `tools/firmware-image-builder/api/src/store.ts`
- Create: `tools/firmware-image-builder/test/unit/store.test.ts`

- [ ] **Step 1: Write the failing test.** Test enqueue plus event, cancellation request plus event, FIFO claim plus dispatch event, stage plus event, operation result plus event, terminal result plus event, and freshness result plus event as single transactions. Test database restart recovery from SQLite with `runtime.json` deliberately stale.

- [ ] **Step 2: Run the failing test.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/store.test.ts`

Expected: FAIL because store transactions and durable event insertion do not exist.

- [ ] **Step 3: Implement the store.** Add typed methods for job creation, queue position, cancellation fields, source identity, stage rows, operation rows, evidence references, event sequence, runtime diagnostics, artifact metadata, publish metadata, and freshness. Ensure every state or structured event update commits together and JSON snapshots never establish state.

- [ ] **Step 4: Run the identical command.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/store.test.ts`

Expected: PASS with rollback tests proving no partial transition or event remains after an injected transaction failure.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/store.ts tools/firmware-image-builder/test/unit/store.test.ts
git commit -m "feat: add transactional builder store"
```

### Task 7: Enforce actor ownership and compare-and-set transitions

**Files:**
- Create: `tools/firmware-image-builder/api/src/ownership.ts`
- Create: `tools/firmware-image-builder/test/unit/ownership.test.ts`

- [ ] **Step 1: Write the failing test.** Test API rejection of runner-owned container, lease, normal stage, terminal, artifact, and live publish writes. Test runner rejection of API queue, cancellation-request, cleanup-admission, and recovery-terminal writes. Test cleanup-worker writes limited to its matching lease, cleanup evidence, exact identity clear, and no state/terminal/publish changes. Test stale predecessor, runner identity, and non-null fence CAS failures produce zero rows and no events.

- [ ] **Step 2: Run the failing test.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/ownership.test.ts`

Expected: FAIL because actor guards and CAS predicates do not exist.

- [ ] **Step 3: Implement actor guards.** Define explicit `apiWrite`, `runnerWrite`, and `cleanupWrite` methods that add actor and fence predicates to SQL updates. Implement the transition matrix from spec section 9, including Direct interruption proof requirements and the prohibition on interruption of `publishing`. Return a zero-row ownership conflict without appending an event.

- [ ] **Step 4: Run the identical command.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/ownership.test.ts`

Expected: PASS with ownership and CAS race tests green.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/ownership.ts tools/firmware-image-builder/test/unit/ownership.test.ts
git commit -m "feat: enforce actor-owned CAS transitions"
```

### Task 8: Implement deterministic branch slugs and safe release paths

**Files:**
- Create: `tools/firmware-image-builder/domain/paths.ts`
- Create: `tools/firmware-image-builder/test/unit/paths.test.ts`

- [ ] **Step 1: Write the failing test.** Test byte-wise percent encoding of branch names, retention of full 40-character SHAs, stable target paths, collision detection, path traversal rejection, symlinked roots, no-follow evidence resolution, symlink-component rejection, and quarantine/staging confinement. Test `withNoFollowFileUnderRoot()` reads and hashes through held directory/file handles. Race the callback by swapping a validated directory component for a symlink before the read/hash: the already-held original handle must still produce the original bytes, while a component that cannot be opened no-follow must be rejected. Assert output path calculation accepts a root ID only and never a submitted path.

- [ ] **Step 2: Run the failing test.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/paths.test.ts`

Expected: FAIL because path encoding and release path resolution do not exist.

- [ ] **Step 3: Implement paths.** Add `encodeBranchSlug()` that leaves only `A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, and `~` literal and emits uppercase `%HH` for every other UTF-8 byte. Add typed staging, quarantine, release, and evidence path constructors that revalidate canonical roots and existing destination collisions. Export `withNoFollowFileUnderRoot(root, relative, callback)`, which accepts only stable non-empty relative paths, opens the root and every directory/file component with `O_NOFOLLOW` or an equivalent native no-follow operation, keeps all directory handles and the final file handle open for the entire async callback, and closes them in `finally`. The callback receives the held file handle and reads, validates, and hashes through that handle; the helper never returns a pathname as a trust token and rejects absolute paths, `.`, `..`, symlink components, and escapes before any callback.

- [ ] **Step 4: Run the identical command.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/paths.test.ts`

Expected: PASS with injective paths, no escape from configured roots, held-handle reads surviving a component swap, and symlink races rejected without pathname reopen.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/domain/paths.ts tools/firmware-image-builder/test/unit/paths.test.ts
git commit -m "feat: resolve safe deterministic release paths"
```

### Task 9: Add the API-owned Git command and source resolver

**Files:**
- Create: `tools/firmware-image-builder/api/src/git/git-command.ts`
- Create: `tools/firmware-image-builder/api/src/git/source-resolver.ts`
- Create: `tools/firmware-image-builder/test/unit/source-resolver.test.ts`

- [ ] **Step 1: Write the failing test.** Test SSH origin validation, branch grammar, rejection of `..`, local heads, HTTPS/local remotes, non-commit refs, `fetch origin --prune`, remote SHA resolution, commit metadata, and source freshness. Test branch movement between display and acceptance returns `BRANCH_MOVED` without a job row. Test the runner resolver interface has no fetch or SSH operation.

- [ ] **Step 2: Run the failing test.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/source-resolver.test.ts`

Expected: FAIL because the Git command wrapper and API-only resolver do not exist.

- [ ] **Step 3: Implement source resolution.** Keep all fetch and remote ref resolution in the API. Use argument arrays and a fixed environment. Implement `listBranches()` from fetched `refs/remotes/origin/*`, `resolveAtAcceptance(branch, expectedSha)`, commit metadata persistence, and `requestFreshness()` returning `fresh`, `advanced`, or informational `unknown`. Expose no SSH credentials or fetch method to runner code.

- [ ] **Step 4: Run the identical command.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/source-resolver.test.ts`

Expected: PASS with mismatch insertion count equal to zero and runner source interface free of network Git operations.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/git tools/firmware-image-builder/test/unit/source-resolver.test.ts
git commit -m "feat: pin origin branches through API resolver"
```

### Task 10: Add preflight checks and expiry

**Files:**
- Create: `tools/firmware-image-builder/api/src/preflight.ts`
- Create: `tools/firmware-image-builder/test/unit/preflight.test.ts`

- [ ] **Step 1: Write the failing test.** Test `POST /api/preflight` domain behavior with exact ten-minute expiry, expected SHA comparison, approved-root IDs, target manifest selection, disk space on worktree/output filesystems, executable checks for Git/Docker/Node/npm/sqlite3/systemd, generated installed builder lock/image digest, root collision, and same-filesystem staging. Assert preflight performs no worktree, Docker, output, or queue mutation.

- [ ] **Step 2: Run the failing test.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/preflight.test.ts`

Expected: FAIL because typed preflight checks and expiry do not exist.

- [ ] **Step 3: Implement preflight.** Reuse source resolver and manifest validator, return `preflightId`, observed SHA, expiry, and check records, and keep checks read-only. Require a generated installed lock with valid Dockerfile/base/image/execution-definition digests. Queue acceptance repeats every check; preflight expires exactly ten minutes after creation.

- [ ] **Step 4: Run the identical command.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/preflight.test.ts`

Expected: PASS with expired, mismatched, invalid-root, and unavailable-tool cases returning stable typed errors and zero mutation.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/preflight.ts tools/firmware-image-builder/test/unit/preflight.test.ts
git commit -m "feat: add typed build preflight checks"
```

### Task 11: Create and validate the complete tool-owned builder source

**Files:**
- Create: `tools/firmware-image-builder/builder/Dockerfile`
- Create: `tools/firmware-image-builder/builder/builder-lock.schema.json`
- Create: `tools/firmware-image-builder/builder/derive-dockerfile.ts`
- Create: `tools/firmware-image-builder/builder/validate-builder.ts`
- Create: `tools/firmware-image-builder/builder/validate-rust-toolchain.ts`
- Create: `tools/firmware-image-builder/builder/execution-definition.json`
- Create: `tools/firmware-image-builder/test/fixtures/builder/non-installable-lock.json`
- Create: `tools/firmware-image-builder/test/unit/builder-source.test.ts`
- Create: `tools/firmware-image-builder/test/integration/builder-image.test.ts`

- [ ] **Step 1: Write the failing tests.** Test the exact lock schema fields and permitted additions, including rejection of `schemaVersion: "1"`, `schemaVersion: 0`, and non-integer schema versions, rejection of mutable base tags, absent or sentinel image/base/execution-definition digests, Dockerfile hash mismatch, missing GCC 14, Node below 22, missing LLVM/Polly/Zstd, Rust CI LLVM artifact use, unresolved validation evidence, and missing package requirements. Test the trusted derivation check against current `Dockerfile-devel`: package/toolchain drift returns `BUILDER_SOURCE_DRIFT` before installation or build mutation. Test the committed fixture lock has `installable: false` and cannot be passed to the installer.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/builder-source.test.ts test/integration/builder-image.test.ts`

Expected: FAIL because the complete tool-owned Dockerfile, lock schema, fixture rejection, and validation logic do not exist.

- [ ] **Step 3: Implement the builder source.** Create a complete tool-owned `builder/Dockerfile` with a digest-pinned Debian base, GCC 14, Node >=22, npm, OpenWrt tools, `llvm-dev`, matching `libpolly-<LLVM-major>-dev`, `libzstd-dev`, and the supported Rust LLVM configuration. Do not modify root `Dockerfile-devel`, do not create a patch file, and do not build from branch Compose. `derive-dockerfile.ts` reads root `Dockerfile-devel` only to compare its supported package/tool list against the tool-owned file and fails on drift. Define `builder-lock.schema.json` as JSON Schema with `schemaVersion: { "type": "integer", "const": 1 }` and these other required fields: `packageVersion`, `imageRepository`, `imageDigest`, `baseImage`, `baseImageDigest`, `dockerfileSha256`, `packageSet`, `rustConfig`, `nodeVersion`, `executionDefinitionSha256`, and `validationEvidenceSha256`. Each digest field is exactly 64 lowercase hexadecimal characters. The only permitted additional fields are `installable`, `publisherSha256`, and optional `imageId`; `imageRepository@sha256:imageDigest` is the canonical builder image reference. The committed fixture sets `installable: false`, uses fixture-only evidence, and is rejected by production validation. No production lock is committed; the installer creates one only after image build and validation.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/builder-source.test.ts test/integration/builder-image.test.ts`

Expected: PASS with valid generated-lock fixtures accepted, the non-installable fixture rejected, and source/toolchain drift rejected before Docker build.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/builder tools/firmware-image-builder/test/fixtures/builder/non-installable-lock.json tools/firmware-image-builder/test/unit/builder-source.test.ts tools/firmware-image-builder/test/integration/builder-image.test.ts
git commit -m "feat: add complete locked builder source"
```

### Task 12: Implement the direct per-operation Docker lifecycle

**Files:**
- Create: `tools/firmware-image-builder/runner/src/command-executor.ts`
- Create: `tools/firmware-image-builder/runner/src/docker-executor.ts`
- Create: `tools/firmware-image-builder/runner/src/operation-registry.ts`
- Create: `tools/firmware-image-builder/test/unit/docker-executor.test.ts`
- Create: `tools/firmware-image-builder/test/integration/docker-lifecycle.test.ts`

- [ ] **Step 1: Write the failing tests.** Test trusted argv factories for every operation ID. Test `docker create` without `--rm`, exact job/manifest labels, exact container name, one worktree mount, explicit UID/GID, fixed environment, bridge network, `--cap-drop=ALL`, no devices, no socket, no privilege, and `SOURCE_DATE_EPOCH`. Test inspect rejection for wrong image, label, mount, user, capability, security setting, or inherited environment. Test operation result commit before exact removal and cleanup CAS. When Docker is unavailable, the integration test must assert typed `available: false` plus zero mutation rather than omit the test.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/docker-executor.test.ts test/integration/docker-lifecycle.test.ts`

Expected: FAIL because the operation registry and Docker protocol do not exist.

- [ ] **Step 3: Implement the lifecycle.** Use trusted TypeScript argv factories selected by operation IDs. Before creation, prove SQLite has null container columns and Docker has no matching job label. Create and inspect the stopped container, persist identity before `docker start --attach`, stream output, commit immutable operation evidence while retaining identity, remove the exact persisted ID, verify absence, then clear active identity through runner CAS. Never inherit the host environment and never invoke branch shell text.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/docker-executor.test.ts test/integration/docker-lifecycle.test.ts`

Expected: PASS with fake Docker covering every mismatch and exact lifecycle order.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/runner/src/command-executor.ts tools/firmware-image-builder/runner/src/docker-executor.ts tools/firmware-image-builder/runner/src/operation-registry.ts tools/firmware-image-builder/test/unit/docker-executor.test.ts tools/firmware-image-builder/test/integration/docker-lifecycle.test.ts
git commit -m "feat: enforce direct Docker operation lifecycle"
```

### Task 13: Add the native publisher and production TypeScript client

**Files:**
- Create: `tools/firmware-image-builder/publisher/osi-image-publish.c`
- Create: `tools/firmware-image-builder/publisher/Makefile`
- Create: `tools/firmware-image-builder/publisher/test-publisher.sh`
- Create: `tools/firmware-image-builder/publisher/client.ts`
- Create: `tools/firmware-image-builder/runner/src/publisher-client.ts`
- Create: `tools/firmware-image-builder/test/unit/publisher-contract.test.ts`
- Create: `tools/firmware-image-builder/test/unit/publisher-client.test.ts`
- Create: `tools/firmware-image-builder/test/integration/publisher.test.ts`

- [ ] **Step 1: Write the failing tests.** Test the exact C17 warning-as-error flags, `--version`, `--self-test`, symlink/traversal rejection, block-device rejection, held directory descriptors, fsync, same-filesystem staging, no-overwrite collision, post-rename mismatch reporting, and the distinction between an existing mismatched destination and surviving staging. Test the production TypeScript client rejects arbitrary paths, passes only validated argv, parses structured helper output, and reports unsupported-host results without claiming publication. When the native capability is unavailable, the integration test must assert typed `available: false` plus zero mutation rather than omit the test.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/publisher-contract.test.ts test/unit/publisher-client.test.ts test/integration/publisher.test.ts`

Expected: FAIL because the C helper, production client, and runner client path do not exist.

- [ ] **Step 3: Implement publication.** Compile `osi-image-publish.c` with `-std=c17 -D_GNU_SOURCE -O2 -Wall -Wextra -Werror`. Open root, branch, and SHA directories with `openat`/`O_NOFOLLOW`, reject symlinks and escapes, fsync all files/directories, and perform one `renameat2(..., RENAME_NOREPLACE)` using held parent FDs. Accept only validated staging/root/branch/SHA/target basename arguments. Make self-test use a private scratch tree and delete only that tree. Put the production client in `publisher/client.ts`, expose the runner adapter through `runner/src/publisher-client.ts`, and use both for publish, quarantine, and non-destructive recheck.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/publisher-contract.test.ts test/unit/publisher-client.test.ts test/integration/publisher.test.ts`

Expected: PASS on a Linux filesystem with `renameat2(RENAME_NOREPLACE)`; unsupported hosts return a named typed prerequisite and the integration assertions prove zero mutation.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/publisher tools/firmware-image-builder/runner/src/publisher-client.ts tools/firmware-image-builder/test/unit/publisher-contract.test.ts tools/firmware-image-builder/test/unit/publisher-client.test.ts tools/firmware-image-builder/test/integration/publisher.test.ts
git commit -m "feat: add native publisher client boundary"
```

### Task 14: Add evidence files and source worktree setup

**Files:**
- Create: `tools/firmware-image-builder/runner/src/evidence.ts`
- Create: `tools/firmware-image-builder/runner/src/source.ts`
- Create: `tools/firmware-image-builder/test/unit/source-evidence.test.ts`
- Create: `tools/firmware-image-builder/test/integration/source-worktree.test.ts`

- [ ] **Step 1: Write the failing tests.** Test one immutable evidence file for every stage on pass and failure. Test persisted source metadata, commit verification, detached worktree creation, submodule initialization, exact target-output absence after submodules and before mutation, clean detached status, and unchanged dirty active checkout.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/source-evidence.test.ts test/integration/source-worktree.test.ts`

Expected: FAIL because evidence writing and detached worktree setup do not exist.

- [ ] **Step 3: Implement source/evidence.** Add typed evidence serialization with job ID, stage, timestamps, outcome, trusted operation ID, captured argv/exit code, observations, error code, and recovery action. Create job-owned worktrees at the persisted SHA, initialize submodules, assert the target OpenWrt output directory is absent, record `observations.targetOutputAbsent: true`, then permit mutation. Never operate on the active checkout.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/source-evidence.test.ts test/integration/source-worktree.test.ts`

Expected: PASS with evidence written before stage transitions and source collision detected before mutation.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/runner/src/evidence.ts tools/firmware-image-builder/runner/src/source.ts tools/firmware-image-builder/test/unit/source-evidence.test.ts tools/firmware-image-builder/test/integration/source-worktree.test.ts
git commit -m "feat: add source worktrees and stage evidence"
```

### Task 15: Implement target setup, feed reinstall, and typed config

**Files:**
- Create: `tools/firmware-image-builder/runner/src/target-setup.ts`
- Create: `tools/firmware-image-builder/test/unit/target-setup.test.ts`
- Create: `tools/firmware-image-builder/test/integration/feed-config.test.ts`

- [ ] **Step 1: Write the failing tests.** Test `make switch-env ENV=<validated environment>`, repository `feeds.conf.default` copy/hash, local ChirpStack feed resolution, named reverse-applicable rootfs patch acceptance, rejection of any other reverse patch or incomplete stack, feed update/install, required package links, target/profile/rootfs symbols, `make -C openwrt defconfig`, both-profile source/config checks, and source/resolved config hashes.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/target-setup.test.ts test/integration/feed-config.test.ts`

Expected: FAIL because target setup, feed reinstall, patch decision, and typed config checks do not exist.

- [ ] **Step 3: Implement setup.** Invoke only registered operations in the locked builder. Run `switch-env` in the detached worktree, copy and hash the pinned repository feed file immediately afterward, verify the local feed points to the pinned worktree, accept only the named rootfs-padding reverse state with the expected implementation, and invoke the hash-gated `OPENWRT_RUST_FEED_CONTRACT` before any feed update or install. That contract is the exact `lang/rust/Makefile` blob from packages commit `d8cd30f4e281d6853b3de134c4f147a807583e43`; it replaces only the one `--set=llvm.download-ci-llvm=true \\` inside `HOST_CONFIGURE_ARGS` and inserts the exact host-target `llvm-config` setting there. The enforcement must reject an unknown source hash, path, commit, host triple, or transformation and every mismatch fails with typed `RUST_BOOTSTRAP_UNAVAILABLE`. Then update/install feeds, verify Node-RED/ChirpStack/sqlite links, and resolve every typed manifest symbol for both profiles.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/target-setup.test.ts test/integration/feed-config.test.ts`

Expected: PASS with missing feed links, target mismatches, and ambiguous patches failing before build.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/runner/src/target-setup.ts tools/firmware-image-builder/test/unit/target-setup.test.ts tools/firmware-image-builder/test/integration/feed-config.test.ts
git commit -m "feat: reinstall feeds and resolve target config"
```

### Task 16: Implement artifact, rootfs, checksum, and freshness verification

**Files:**
- Create: `tools/firmware-image-builder/runner/src/verification.ts`
- Create: `tools/firmware-image-builder/test/unit/verification.test.ts`
- Create: `tools/firmware-image-builder/test/integration/rootfs-verification.test.ts`

- [ ] **Step 1: Write the failing tests.** Test exact one-image cardinality, source absence evidence, 64 MiB floor, original OpenWrt checksum as evidence only, image-only generated checksum, gzip, both profile/source hashes, required files, nginx routes, GUI title/hash, critical flow/database/GUI hashes, protobufjs/helper resolution, SQLite `integrity_check`, Chameleon zero rows, and `fresh`/`advanced`/`unknown` freshness evidence. Test stale, small, missing, and duplicate artifacts.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/verification.test.ts test/integration/rootfs-verification.test.ts`

Expected: FAIL because artifact and rootfs verification do not exist.

- [ ] **Step 3: Implement verification.** Resolve exactly one factory image after build, require source-stage `observations.targetOutputAbsent`, use mtime only as supporting evidence, validate all manifest/runtime observations, generate and verify an image-only checksum, and write complete verification evidence including `observations.freshnessStatus`. Request final freshness through the API socket; `unknown` never downgrades a verified pinned build.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/verification.test.ts test/integration/rootfs-verification.test.ts`

Expected: PASS with invalid or incomplete artifacts unable to enter publication.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/runner/src/verification.ts tools/firmware-image-builder/test/unit/verification.test.ts tools/firmware-image-builder/test/integration/rootfs-verification.test.ts
git commit -m "feat: verify firmware artifacts and rootfs payload"
```

### Task 17: Wire the normal runner pipeline and publish recovery record

**Files:**
- Create: `tools/firmware-image-builder/runner/src/pipeline.ts`
- Create: `tools/firmware-image-builder/runner/src/main.ts`
- Create: `tools/firmware-image-builder/test/unit/pipeline.test.ts`
- Create: `tools/firmware-image-builder/test/integration/pipeline-order.test.ts`

- [ ] **Step 1: Write the failing tests.** Test ordered states `starting` through `publishing`, one operation at a time, evidence before each transition, normal terminal ownership, manifest/config/tool/artifact metadata, atomic publish start, post-rename verification, complete destination recovery, absent destination with surviving staging, mismatched final path blocker, and `EEXIST` collision.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/pipeline.test.ts test/integration/pipeline-order.test.ts`

Expected: FAIL because normal runner orchestration and publish recovery records do not exist.

- [ ] **Step 3: Implement the pipeline.** Execute the ten manifest stages through the trusted operation registry. Persist runner lease and identity, write evidence before transitions, commit `publish_started` before native publication, and write build/verification manifests containing numeric `schemaVersion: 1`, the exact lock fields `packageVersion`, `imageRepository`, `imageDigest`, `baseImage`, `baseImageDigest`, `dockerfileSha256`, `packageSet`, `rustConfig`, `nodeVersion`, `executionDefinitionSha256`, and `validationEvidenceSha256`, plus `builderLockSha256`, the derived canonical image reference, and the target-manifest hash. Re-open and verify the published directory, and commit `succeeded` only after matching post-rename evidence. Preserve explicit blockers and never claim staging moved when the helper did not prove it.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/pipeline.test.ts test/integration/pipeline-order.test.ts`

Expected: PASS with one target and one terminal path per runner job.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/runner/src/pipeline.ts tools/firmware-image-builder/runner/src/main.ts tools/firmware-image-builder/test/unit/pipeline.test.ts tools/firmware-image-builder/test/integration/pipeline-order.test.ts
git commit -m "feat: run verified firmware pipeline"
```

### Task 18: Implement cooperative runner cancellation only

**Files:**
- Create: `tools/firmware-image-builder/runner/src/cancellation.ts`
- Create: `tools/firmware-image-builder/test/unit/runner-cancellation.test.ts`
- Create: `tools/firmware-image-builder/test/integration/runner-cancellation.test.ts`

- [ ] **Step 1: Write the failing tests.** Test runner handling of `SIGUSR1`, cancellation observation between stages and operations, exact persisted container validation, controlled stop request, cooperative wait, identity retention until exact removal/absence and cleanup CAS, and no runner transition from `publishing`. Do not test API queue cancellation or systemd escalation in this task.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/runner-cancellation.test.ts test/integration/runner-cancellation.test.ts`

Expected: FAIL because cooperative runner cancellation does not exist.

- [ ] **Step 3: Implement runner cancellation.** Add signal handling and runner-owned cancellation transitions. Revalidate the persisted container ID/name and both labels, stop only that exact container through the Docker executor, retain identity until cleanup CAS, and emit evidence for controlled cancellation. Do not implement API signals, queued cancellation, or forced-stop escalation here.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/runner-cancellation.test.ts test/integration/runner-cancellation.test.ts`

Expected: PASS with cooperative runner cancellation isolated from API coordination.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/runner/src/cancellation.ts tools/firmware-image-builder/test/unit/runner-cancellation.test.ts tools/firmware-image-builder/test/integration/runner-cancellation.test.ts
git commit -m "feat: add cooperative runner cancellation"
```

### Task 19: Add API cancellation coordination and systemd escalation

**Files:**
- Create: `tools/firmware-image-builder/api/src/cancellation.ts`
- Create: `tools/firmware-image-builder/test/unit/api-cancellation.test.ts`
- Create: `tools/firmware-image-builder/test/integration/api-cancellation.test.ts`

- [ ] **Step 1: Write the failing tests.** Test queued cancellation before dispatch, active cancellation signal through the runner unit, 30-second cooperative deadline, `systemctl --user stop` escalation, 15-second systemd grace, forced-kill recovery blocker, `publishing` late-request behavior, and no API claim of `cancelled` or `interrupted` without the runner result or Direct interruption proof.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/api-cancellation.test.ts test/integration/api-cancellation.test.ts`

Expected: FAIL because API cancellation coordination and escalation do not exist.

- [ ] **Step 3: Implement API coordination.** Add `requestCancellation()`, runner signal dispatch, bounded cooperative wait, systemd stop escalation, and recovery-blocker recording. Keep queue/cancellation fields API-owned and normal cancellation terminal transitions runner-owned. Do not stop or remove Docker containers directly from API code; recovery remains the cleanup-worker responsibility.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/api-cancellation.test.ts test/integration/api-cancellation.test.ts`

Expected: PASS with API coordination unable to write runner-owned terminal or container fields.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/cancellation.ts tools/firmware-image-builder/test/unit/api-cancellation.test.ts tools/firmware-image-builder/test/integration/api-cancellation.test.ts
git commit -m "feat: coordinate API cancellation escalation"
```

### Task 20: Implement cleanup admission credentials and rotation

**Files:**
- Create: `tools/firmware-image-builder/api/src/recovery.ts`
- Create: `tools/firmware-image-builder/test/unit/cleanup-admission.test.ts`
- Create: `tools/firmware-image-builder/test/integration/cleanup-credential-crash.test.ts`

- [ ] **Step 1: Write the failing tests.** Cover credential creation before admission commit, durable mode `0600` file/parent fsync, owner and non-symlink checks, token hash/generation, orphan credential pruning after a pre-commit crash, admission committed before worker start, missing/corrupt credential rotation, old token rejection, safe Admission ID grammar, and exact persisted cleanup unit name.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/cleanup-admission.test.ts test/integration/cleanup-credential-crash.test.ts`

Expected: FAIL because cleanup admissions, credentials, and generation rotation do not exist.

- [ ] **Step 3: Implement admission credentials.** Create the credential in the fixed job-owned directory before the admission transaction, fsync it and its parent, store only relative path/hash/generation, and atomically install the fence, stale runner snapshot, admission ID, and exact `osi-image-builder-cleanup@<admission-id>.service` name. Rotate generation/token through CAS for invalid or expired admissions and never pass plaintext tokens to argv or environment.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/cleanup-admission.test.ts test/integration/cleanup-credential-crash.test.ts`

Expected: PASS with orphan files safely pruned only when no matching admission exists and stale credentials unable to claim.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/recovery.ts tools/firmware-image-builder/test/unit/cleanup-admission.test.ts tools/firmware-image-builder/test/integration/cleanup-credential-crash.test.ts
git commit -m "feat: fence cleanup admissions with durable credentials"
```

### Task 21: Implement the cleanup worker exact-container protocol

**Files:**
- Create: `tools/firmware-image-builder/cleanup-worker/src/main.ts`
- Create: `tools/firmware-image-builder/test/unit/cleanup-worker.test.ts`
- Create: `tools/firmware-image-builder/test/integration/cleanup-worker.test.ts`

- [ ] **Step 1: Write the failing tests.** Cover admitted-before-start, claimed active/unexpired, claimed inactive/unexpired, claimed inactive/expired, claimed active/expired, active/stale stop failure, wrong unit, wrong admission, wrong generation/token, wrong label, non-listed state, exact present container, exact already-absent container, and staging/log-only blocker. Test that the worker cannot change job state, terminal, queue, or publish fields.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/cleanup-worker.test.ts test/integration/cleanup-worker.test.ts`

Expected: FAIL because cleanup-worker claim, validation, and exact cleanup do not exist.

- [ ] **Step 3: Implement the worker.** Accept only `%i` as the systemd dynamic argument. Resolve job and cleanup fields from the matching SQLite admission, validate credential/fence/unit/lease/identity, claim by CAS, unlink and fsync the credential, stop/remove only the exact persisted container when present, prove exact absence plus global no-label state, seal logs, quarantine staging, record evidence, and clear active container columns through cleanup-worker CAS while retaining the fence. A stop failure retains the fence and prevents replacement start.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/cleanup-worker.test.ts test/integration/cleanup-worker.test.ts`

Expected: PASS with every invalid admission blocked before Docker/filesystem action and every valid cleanup limited to the admitted job.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/cleanup-worker tools/firmware-image-builder/test/unit/cleanup-worker.test.ts tools/firmware-image-builder/test/integration/cleanup-worker.test.ts
git commit -m "feat: add fenced cleanup worker"
```

### Task 22: Implement cleanup hand-back and recovery crash windows

**Files:**
- Modify: `tools/firmware-image-builder/api/src/recovery.ts`
- Create: `tools/firmware-image-builder/test/unit/recovery-handback.test.ts`
- Create: `tools/firmware-image-builder/test/integration/recovery-crash-windows.test.ts`

- [ ] **Step 1: Write the failing tests.** Test exact removal crash before `docker rm`, after exact removal before cleanup CAS, and after cleanup CAS before API hand-back. Test delayed old worker after rotated admission/credential. Test API hand-back independently verifies exact absence, global no-label state, cleanup CAS, inactive unit, stale lease, log sealing, staging quarantine, and blocker resolution before clearing the fence. Test stale active jobs become `interrupted`; already interrupted jobs remain terminal; queue release waits for hand-back.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/recovery-handback.test.ts test/integration/recovery-crash-windows.test.ts`

Expected: FAIL because recovery hand-back and crash-window reconciliation do not exist.

- [ ] **Step 3: Implement hand-back.** Reconcile completed admissions without starting a second worker, retain identity/fence until cleanup CAS is durable, clear the fence only in API hand-back, and keep failed/blocking admissions fenced until explicit corrected retry. Handle exact present and exact absent container protocols without changing interrupted terminal state.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/recovery-handback.test.ts test/integration/recovery-crash-windows.test.ts`

Expected: PASS with both exact-removal windows and delayed-old-unit cases preserving the recovery handle and queue blocker until hand-back.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/recovery.ts tools/firmware-image-builder/test/unit/recovery-handback.test.ts tools/firmware-image-builder/test/integration/recovery-crash-windows.test.ts
git commit -m "feat: complete cleanup recovery hand-back"
```

### Task 23: Implement FIFO dispatch and service-start recovery

**Files:**
- Create: `tools/firmware-image-builder/api/src/queue.ts`
- Create: `tools/firmware-image-builder/test/unit/queue-dispatch.test.ts`
- Create: `tools/firmware-image-builder/test/integration/queue-service-start.test.ts`

- [ ] **Step 1: Write the failing tests.** Test FIFO claim, one active runner, dispatcher claim crash before service start, service-start failure, `starting` recovery blocker, no return to queue, next-job ordering, and queue release only after Direct interruption proof or cleanup hand-back.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/queue-dispatch.test.ts test/integration/queue-service-start.test.ts`

Expected: FAIL because the FIFO dispatcher and service-start recovery do not exist.

- [ ] **Step 3: Implement dispatch.** Claim the oldest queued row by CAS, set `starting`, record the exact runner unit, start it through user systemd, and retain the claimed row and recovery blocker if service start fails. Never dispatch a second job while the first has a live unit, unresolved recovery, fence, identity, or publish blocker.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/queue-dispatch.test.ts test/integration/queue-service-start.test.ts`

Expected: PASS with FIFO ordering and service-start failure recovery covered.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/queue.ts tools/firmware-image-builder/test/unit/queue-dispatch.test.ts tools/firmware-image-builder/test/integration/queue-service-start.test.ts
git commit -m "feat: add FIFO dispatcher and service-start recovery"
```

### Task 24: Add systemd unit contracts

**Files:**
- Create: `tools/firmware-image-builder/systemd/osi-image-builder.service`
- Create: `tools/firmware-image-builder/systemd/osi-image-builder-runner@.service`
- Create: `tools/firmware-image-builder/systemd/osi-image-builder-cleanup@.service`
- Create: `tools/firmware-image-builder/test/unit/systemd-contract.test.ts`
- Create: `tools/firmware-image-builder/test/integration/systemd-unit.test.ts`

- [ ] **Step 1: Write the failing tests.** Test loopback API service and `default.target` wanted state, runner independence from API, runner `KillMode=control-group`, 15-second stop timeout, `SIGUSR1`, `Restart=no`, no default-target runner, cleanup `%i`-only dynamic argument, no job/token argv or environment, restricted cleanup paths, and no cleanup default-target dependency. When a user systemd manager is unavailable, the integration test must assert typed `available: false` plus zero mutation rather than omit the test.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/systemd-contract.test.ts test/integration/systemd-unit.test.ts`

Expected: FAIL because the unit templates and contract checks do not exist.

- [ ] **Step 3: Implement unit templates.** Add the API, runner, and cleanup templates with exact lifecycle and sandbox properties from spec sections 11, 12, and 19. Keep runner units independent from API restart. Pass only `%i` to cleanup; the worker resolves job and credential data from SQLite.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/systemd-contract.test.ts test/integration/systemd-unit.test.ts`

Expected: PASS with all unit contract and user-manager fixture checks green.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/systemd tools/firmware-image-builder/test/unit/systemd-contract.test.ts tools/firmware-image-builder/test/integration/systemd-unit.test.ts
git commit -m "feat: add restricted user systemd units"
```

### Task 25: Add native host and filesystem prerequisite probes

**Files:**
- Create: `tools/firmware-image-builder/installer/probe-host.c`
- Create: `tools/firmware-image-builder/installer/probe-renameat2.c`
- Create: `tools/firmware-image-builder/test/unit/host-probes.test.ts`
- Create: `tools/firmware-image-builder/test/integration/host-probes.test.ts`

- [ ] **Step 1: Write the failing tests.** Test typed detection of GCC, libc headers, `make`, Linux `renameat2`, `RENAME_NOREPLACE`, and unsupported filesystem results. Test that a failed probe performs zero installation-selection or output mutation and returns a named prerequisite rather than skipping the check; the integration test must execute and assert the typed unavailable result.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/host-probes.test.ts test/integration/host-probes.test.ts`

Expected: FAIL because the C probes and typed result adapter do not exist.

- [ ] **Step 3: Implement probes.** Compile the C17 header and syscall probes, exercise `RENAME_NOREPLACE` on a private temporary filesystem location, and return `{ available: false, code, detail }` for unsupported hosts. Do not mark unsupported hosts as skipped and do not mutate the installed selection or approved output roots.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/host-probes.test.ts test/integration/host-probes.test.ts`

Expected: PASS with supported hosts passing and unsupported hosts producing typed non-skipped results with zero mutation.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/installer/probe-host.c tools/firmware-image-builder/installer/probe-renameat2.c tools/firmware-image-builder/test/unit/host-probes.test.ts tools/firmware-image-builder/test/integration/host-probes.test.ts
git commit -m "feat: probe host and filesystem prerequisites"
```

### Task 26: Implement startup reconciliation in the exact order

**Files:**
- Modify: `tools/firmware-image-builder/api/src/recovery.ts`
- Modify: `tools/firmware-image-builder/api/src/queue.ts`
- Create: `tools/firmware-image-builder/api/src/startup-order.ts`
- Create: `tools/firmware-image-builder/test/unit/startup-recovery.test.ts`
- Create: `tools/firmware-image-builder/test/integration/startup-recovery.test.ts`

- [ ] **Step 1: Write the failing tests.** Assert startup invokes these phases in exact order: migrations, cleanup admissions, live-runner classification, stale-publishing recovery, non-publishing interruption, retention, then dispatch. Test all claimed admission lease combinations, active/unexpired deferral, inactive/unexpired rotation, inactive/expired rotation, active/expired bounded stop, stop failure without replacement, stale publishing before interruption, Direct interruption proof, cleanup-worker recovery, and queue blocking.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/startup-recovery.test.ts test/integration/startup-recovery.test.ts`

Expected: FAIL because startup ordering and reconciliation coordinator do not exist.

- [ ] **Step 3: Implement startup order.** Add `startup-order.ts` with injected phase functions and a recorded phase event sequence. Run migrations first, reconcile cleanup admissions second, classify live runner units/leases/labels third, recover stale publishing fourth, recover eligible non-publishing interruption fifth, invoke the retention hook sixth, and dispatch only after all blockers clear seventh. Keep startup recovery independent from the concrete retention implementation created in Task 27 by using a typed hook.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/startup-recovery.test.ts test/integration/startup-recovery.test.ts`

Expected: PASS with exact phase order and no dispatch before recovery blockers clear.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/recovery.ts tools/firmware-image-builder/api/src/queue.ts tools/firmware-image-builder/api/src/startup-order.ts tools/firmware-image-builder/test/unit/startup-recovery.test.ts tools/firmware-image-builder/test/integration/startup-recovery.test.ts
git commit -m "feat: reconcile builder state in startup order"
```

### Task 27: Add health, retention, and observability

**Files:**
- Create: `tools/firmware-image-builder/api/src/health.ts`
- Create: `tools/firmware-image-builder/api/src/retention.ts`
- Create: `tools/firmware-image-builder/test/unit/health-retention.test.ts`
- Create: `tools/firmware-image-builder/test/integration/observability.test.ts`

- [ ] **Step 1: Write the failing tests.** Test health fields for queue depth, active job, stage, event age, disk bytes, generated builder digest, labels, blockers, terminal errors, stale logs, cleanup generation, and hand-back. Test structured redacted records. Test 180-day rows/logs/quarantine, 7-day worktrees, 30-day caches subject to the 20 GiB floor, no published-release pruning, no symlink traversal, and startup hook compatibility.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/health-retention.test.ts test/integration/observability.test.ts`

Expected: FAIL because health, retention, and structured observability do not exist.

- [ ] **Step 3: Implement operations.** Add typed health snapshots and redacted structured records. Implement retention for builder-owned state and quarantine only, recording each prune. Export the retention hook consumed by Task 26 without changing its startup order.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/health-retention.test.ts test/integration/observability.test.ts`

Expected: PASS with health data complete and retention confined to builder-owned paths.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/health.ts tools/firmware-image-builder/api/src/retention.ts tools/firmware-image-builder/test/unit/health-retention.test.ts tools/firmware-image-builder/test/integration/observability.test.ts
git commit -m "feat: add builder health and retention"
```

### Task 28: Add durable log indexing and SSE replay at runner call sites

**Files:**
- Create: `tools/firmware-image-builder/api/src/log-stream.ts`
- Modify: `tools/firmware-image-builder/runner/src/main.ts`
- Modify: `tools/firmware-image-builder/runner/src/pipeline.ts`
- Modify: `tools/firmware-image-builder/runner/src/docker-executor.ts`
- Modify: `tools/firmware-image-builder/cleanup-worker/src/main.ts`
- Create: `tools/firmware-image-builder/test/unit/log-stream.test.ts`
- Create: `tools/firmware-image-builder/test/integration/sse-replay.test.ts`

- [ ] **Step 1: Write the failing tests.** Test fsynced runner/Docker bytes followed by exact SQLite offsets, generations, partial-line flags, sequence cursors, rotation, reconnect, 64 KiB cap, 15-second keepalive, orphan-tail sealing after inactive/stale/no-container proof, shorter-file gap, and no duplicate or invented content. Assert runner `main.ts`, pipeline, Docker executor, and cleanup-worker call sites use the shared log writer and recovery sealing rules.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/log-stream.test.ts test/integration/sse-replay.test.ts`

Expected: FAIL because log indexing, call-site wiring, replay, and SSE encoding do not exist.

- [ ] **Step 3: Implement logs and call sites.** Append and fsync canonical log files before inserting event ranges. Implement durable cursor replay and SSE event types `stage`, `log`, `terminal`, `log-gap`, and `log-truncated`. Wire runner and cleanup-worker stdout/stderr and orphan-tail paths to the shared implementation. Permit API publishing recovery and cleanup-worker tail sealing only after their liveness proofs and before hand-back or terminal events.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/log-stream.test.ts test/integration/sse-replay.test.ts`

Expected: PASS with exact byte-range replay and all listed runner/cleanup call sites covered.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/log-stream.ts tools/firmware-image-builder/runner/src/main.ts tools/firmware-image-builder/runner/src/pipeline.ts tools/firmware-image-builder/runner/src/docker-executor.ts tools/firmware-image-builder/cleanup-worker/src/main.ts tools/firmware-image-builder/test/unit/log-stream.test.ts tools/firmware-image-builder/test/integration/sse-replay.test.ts
git commit -m "feat: add durable logs and SSE replay"
```

### Task 29: Implement the loopback HTTP API and security boundary without static UI serving

**Files:**
- Create: `tools/firmware-image-builder/api/src/routes.ts`
- Create: `tools/firmware-image-builder/api/src/server.ts`
- Create: `tools/firmware-image-builder/api/src/main.ts`
- Create: `tools/firmware-image-builder/test/unit/http-security.test.ts`
- Create: `tools/firmware-image-builder/test/integration/api.test.ts`

- [ ] **Step 1: Write the failing tests.** Test read endpoints, preflight, enqueue, cancel, recover, blocker recheck, branch refresh, evidence, events, and SSE. Require loopback binding, same-origin `Origin`, JSON content type, stable error shape, no stack traces/secrets/arbitrary paths, no cross-origin writes, no unknown target/root, no block-device path, and no cloud/production endpoint. Test 409 `BRANCH_MOVED`, 202 enqueue, terminal cancel rejection, and API-owned final freshness socket result. This task must not serve static UI files.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/http-security.test.ts test/integration/api.test.ts`

Expected: FAIL because HTTP routing and security validation do not exist.

- [ ] **Step 3: Implement HTTP.** Use Node `http` on `127.0.0.1`, expose JSON and SSE routes, validate mutation headers and typed JSON bodies, and delegate to store/source/preflight/queue/cancellation/recovery/log services. Implement `POST /api/jobs` with a second fetch/SHA comparison and source persistence before queue insertion. Do not let HTTP code write live container identity, normal publish, or normal terminal fields. Leave UI asset serving for Task 31 after the UI exists.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/http-security.test.ts test/integration/api.test.ts`

Expected: PASS with all security rejection and response-shape tests green and no static-serving dependency.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/routes.ts tools/firmware-image-builder/api/src/server.ts tools/firmware-image-builder/api/src/main.ts tools/firmware-image-builder/test/unit/http-security.test.ts tools/firmware-image-builder/test/integration/api.test.ts
git commit -m "feat: add secure loopback builder API"
```

### Task 30: Build the React operational console

**Files:**
- Create: `tools/firmware-image-builder/ui/index.html`
- Create: `tools/firmware-image-builder/ui/vite.config.ts`
- Create: `tools/firmware-image-builder/ui/src/main.tsx`
- Create: `tools/firmware-image-builder/ui/src/App.tsx`
- Create: `tools/firmware-image-builder/ui/src/api.ts`
- Create: `tools/firmware-image-builder/ui/src/types.ts`
- Create: `tools/firmware-image-builder/ui/tsconfig.json`
- Create: `tools/firmware-image-builder/ui/src/styles.css`
- Create: `tools/firmware-image-builder/ui/src/components/BuildForm.tsx`
- Create: `tools/firmware-image-builder/ui/src/components/QueueTable.tsx`
- Create: `tools/firmware-image-builder/ui/src/components/JobDetail.tsx`
- Create: `tools/firmware-image-builder/ui/src/components/StatusBadge.tsx`
- Create: `tools/firmware-image-builder/ui/src/__tests__/BuildForm.test.tsx`
- Create: `tools/firmware-image-builder/ui/src/__tests__/QueueTable.test.tsx`
- Create: `tools/firmware-image-builder/ui/src/__tests__/JobDetail.test.tsx`

- [ ] **Step 1: Write the failing tests.** Test fetched origin branches, SHA/commit display, target selection, approved-root selection, read-only destination preview, preflight expiry, validation gating, branch movement error, queue/history states, cancel/recover actions, verification tabs, newer-source action, and durable SSE reconnect. Test credentials and quarantined paths never render as release files.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- ui/src/__tests__/BuildForm.test.tsx ui/src/__tests__/QueueTable.test.tsx ui/src/__tests__/JobDetail.test.tsx && npm exec tsc --noEmit -p ui/tsconfig.json && npm exec vite build --config ui/vite.config.ts`

Expected: FAIL because the builder UI and typed API client do not exist.

- [ ] **Step 3: Implement the UI.** Build the compact two-column desktop console and one-column mobile layout. Use neutral status colors, stable dimensions, 8px-or-smaller radii, lucide icons with tooltips, and no marketing hero. Clear preflight when branch/target/root changes; disable Start until current preflight is valid; show branch SHA, target, root, queue, evidence, runner liveness, stale logs, cleanup generation, blocker, freshness, artifact hash, and recovery actions. Branch on error codes, not messages.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- ui/src/__tests__/BuildForm.test.tsx ui/src/__tests__/QueueTable.test.tsx ui/src/__tests__/JobDetail.test.tsx && npm exec tsc --noEmit -p ui/tsconfig.json && npm exec vite build --config ui/vite.config.ts`

Expected: PASS with all three UI test files green, the UI typecheck passing, and the Vite build producing `ui/dist`.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/ui
git commit -m "feat: add firmware builder operational console"
```

### Task 31: Serve the built UI from the same-origin API

**Files:**
- Create: `tools/firmware-image-builder/api/src/static-ui.ts`
- Modify: `tools/firmware-image-builder/api/src/server.ts`
- Create: `tools/firmware-image-builder/test/unit/static-ui.test.ts`
- Create: `tools/firmware-image-builder/test/integration/static-ui.test.ts`

- [ ] **Step 1: Write the failing tests.** Test serving `ui/dist/index.html` and assets from the same loopback origin, API route precedence, traversal rejection, missing asset response, content types, and refusal to follow symlinks outside the built UI directory. Test that the API cannot start static serving until the UI build directory exists.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/static-ui.test.ts test/integration/static-ui.test.ts`

Expected: FAIL because static UI serving is not implemented.

- [ ] **Step 3: Implement static serving.** Add a no-follow static asset resolver after JSON/SSE routing, serve only the built `ui/dist` tree, preserve one loopback origin, and fail startup with a typed package error when the UI build is absent or unsafe.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/static-ui.test.ts test/integration/static-ui.test.ts`

Expected: PASS with API precedence and UI path confinement covered.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/api/src/static-ui.ts tools/firmware-image-builder/api/src/server.ts tools/firmware-image-builder/test/unit/static-ui.test.ts tools/firmware-image-builder/test/integration/static-ui.test.ts
git commit -m "feat: serve builder UI from loopback API"
```

### Task 32: Add the deterministic browser fixture, full fake scenarios, and single check script

**Files:**
- Create: `tools/firmware-image-builder/test/browser/fixture-server.ts`
- Create: `tools/firmware-image-builder/test/browser/overlap.ts`
- Create: `tools/firmware-image-builder/test/browser/builder.spec.ts`
- Create: `tools/firmware-image-builder/test/browser/screenshots/builder-desktop.png`
- Create: `tools/firmware-image-builder/test/browser/screenshots/builder-mobile.png`
- Create: `tools/firmware-image-builder/test/integration/full-fake-scenarios.test.ts`
- Create: `tools/firmware-image-builder/scripts/check-plan-policy.mjs`
- Modify: `tools/firmware-image-builder/playwright.config.ts`
- Modify: `tools/firmware-image-builder/package.json`

- [x] **Step 1: Write the failing tests.** Add separate fake jobs for Pi 5 success, Pi 4 success, queued cancel, active cancel, cleanup crash before exact removal, cleanup crash after exact removal before CAS, publish recovery, and delayed rotated admission. Assert each job selects one target and has exactly one terminal path. Add a same-origin fixture server test with `GET /api/health`, `POST /test/reset`, deterministic seeded state, and graceful shutdown. Add Playwright assertions for desktop and 390px viewports, `expect(page).toHaveScreenshot('builder-desktop.png', { animations: 'disabled' })`, `expect(page).toHaveScreenshot('builder-mobile.png', { animations: 'disabled' })`, no horizontal overflow, and pairwise bounding-box overlap for controls and status regions.

- [x] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/integration/full-fake-scenarios.test.ts && npm run test:browser && npm run check`

Expected: FAIL because the separate fake scenarios, fixture server, screenshot baselines, overlap helper, policy script, and aggregate check do not exist.

- [x] **Step 3: Implement fixture and scenarios.** The fixture server must bind loopback, serve the same API/UI origin, expose `GET /api/health`, reset only under test mode through `POST /test/reset`, return a deterministic seed, wait for health before tests, and close its listener after Playwright. Configure `playwright.config.ts` with `webServer` to start `tsx test/browser/fixture-server.ts`, `url: http://127.0.0.1:<port>/api/health`, `reuseExistingServer: false`, `timeout: 120000`, `gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 }`, and `snapshotPathTemplate: '{testDir}/screenshots/{arg}{ext}'`. Store committed baselines exactly at `test/browser/screenshots/builder-desktop.png` and `test/browser/screenshots/builder-mobile.png`; `npm run test:browser` is the only Playwright gate, while Vitest runs only `test/integration/full-fake-scenarios.test.ts`. Disable animations in screenshot assertions and fail on overflow or overlapping bounding boxes. Keep each fake scenario in its own temporary database/job directory. Define `npm run check` here exactly once to run Node gate, typecheck, manifest/migration checks, policy scan, native publisher self-test, unit tests, integration tests, `npm run build`, and `npm run test:browser`. The policy script scans executable builder files for dynamic shell text, Docker socket/privilege/device use, production/cloud endpoints, and arbitrary output paths.

- [x] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/integration/full-fake-scenarios.test.ts && npm run test:browser && npm run check`

Expected: PASS with all separate fake jobs green, `npm run test:browser` executing the Playwright spec, fixture reset/lifecycle tests, declared screenshot baselines, overlap checks, and the aggregate `npm run check` gate all returning zero.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/test/browser tools/firmware-image-builder/test/integration/full-fake-scenarios.test.ts tools/firmware-image-builder/scripts/check-plan-policy.mjs tools/firmware-image-builder/playwright.config.ts tools/firmware-image-builder/package.json
git commit -m "test: add deterministic browser and fake scenario gates"
```

### Task 33: Complete the versioned installer, generated production lock, and config command

**Files:**
- Create: `tools/firmware-image-builder/installer/install.ts`
- Create: `tools/firmware-image-builder/installer/configure.ts`
- Create: `tools/firmware-image-builder/test/unit/installer-selection.test.ts`
- Create: `tools/firmware-image-builder/test/integration/installer-selection.test.ts`
- Create: `tools/firmware-image-builder/test/unit/script-graph.test.ts`
- Modify: `tools/firmware-image-builder/package.json`
- Modify: `tools/firmware-image-builder/README.md`

- [ ] **Step 1: Write the failing tests.** Test installer rejection of the non-installable fixture lock, mutable tags, sentinel or unresolved evidence, missing required schema fields, non-64-hex digests, Dockerfile/base/image/execution-definition digest mismatch, missing validated builder image, non-canonical image references, a digest-qualified reference that the service user cannot inspect, missing publisher self-test, and missing host probes. Test transactional versioned installation and selection-file crash behavior. Test generated production `builder.lock.json` is created only inside the new versioned installation after builder image validation and contains exactly `schemaVersion`, `packageVersion`, `imageRepository`, `imageDigest`, `baseImage`, `baseImageDigest`, `dockerfileSha256`, `packageSet`, `rustConfig`, `nodeVersion`, `executionDefinitionSha256`, and `validationEvidenceSha256`, with only the permitted `installable`, `publisherSha256`, and `imageId` additions. Test the package script graph: outer `install:versioned` runs `npm run check` once before the installer core; the core does not invoke npm or `npm run check`; and `check` does not directly or indirectly invoke `install:versioned`. On a host without an installer prerequisite, assert typed `{ available: false, code, detail }` and zero installation/output mutation; never skip the integration file.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/installer-selection.test.ts test/unit/script-graph.test.ts test/integration/installer-selection.test.ts`

Expected: FAIL because the complete installer, generated production lock, crash-safe selection update, and non-recursive package script graph do not exist.

- [ ] **Step 3: Implement installation.** Export an installer core that accepts injected command, filesystem, and service-user dependencies and never spawns npm or `npm run check`. The outer package script `install:versioned` must run the Node gate, run `npm run check` exactly once, and then invoke `tsx installer/install.ts --core`; the core performs only validation and installation. Validate the complete tool-owned Dockerfile against current `Dockerfile-devel`, build and validate the digest-pinned builder image, calculate `imageRepository`, `imageDigest`, and optional `imageId`, derive only the canonical `imageRepository@sha256:imageDigest` reference, and run `docker image inspect` on that reference as the service user. Require exactly one matching canonical repository digest in `.RepoDigests`, compare `.Id` only when `imageId` is present, reject a tag or an image the service user cannot run, and never use `.Id` as a content-digest fallback. Validate the image Config.Env against the locked runtime contract and re-execute the production image verifier against the exact canonical reference before accepting evidence. Validate all exact lock schema fields and evidence, build/self-test the native publisher, generate `~/.local/lib/osi-image-builder/<package-version>/builder.lock.json`, and install the API, runner, cleanup worker, publisher, execution definition, and built UI into that versioned directory. Fsync files/directories and atomically update the selection record only after all checks pass. Never write a production lock to the repository and never install from the committed non-installable fixture. A real Docker or host-probe failure is a typed unavailable result in fake tests but a nonzero installer command in real use.

- [ ] **Step 4: Run the identical tests.**

Run: `cd tools/firmware-image-builder && npm exec vitest run -- test/unit/installer-selection.test.ts test/unit/script-graph.test.ts test/integration/installer-selection.test.ts`

Expected: PASS with non-installable, mutable, unresolved, schema-invalid, non-canonical, and mismatched locks rejected; unsupported-host assertions typed and mutation-free; the script graph proving one outer check with no core recursion; and generated production locks accepted only after image validation.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/installer tools/firmware-image-builder/test/unit/installer-selection.test.ts tools/firmware-image-builder/test/unit/script-graph.test.ts tools/firmware-image-builder/test/integration/installer-selection.test.ts tools/firmware-image-builder/package.json tools/firmware-image-builder/README.md
git commit -m "feat: generate validated versioned builder installations"
```

### Task 34: Add deterministic workstation prerequisite and acceptance guard tests

**Files:**
- Create: `tools/firmware-image-builder/scripts/run-workstation-test.mjs`
- Create: `tools/firmware-image-builder/scripts/accept-real-target.mjs`
- Create: `tools/firmware-image-builder/test/integration/workstation.test.ts`
- Create: `tools/firmware-image-builder/test/integration/release-acceptance.test.ts`
- Create: `tools/firmware-image-builder/test/integration/final-verification.test.ts`
- Modify: `tools/firmware-image-builder/package.json`
- Modify: `tools/firmware-image-builder/README.md`

- [ ] **Step 1: Write the failing tests.** Test deterministic prerequisite adapters for Node >=22, npm, Git SSH origin, Docker, user systemd, sqlite3, GCC/libc/make, Linux `renameat2`, generated installed lock/image, approved root, and free disk. Each missing prerequisite must return a typed unavailable result and prove zero state/output mutation. Test the guarded commands `accept:pi5`, `accept:pi4`, and `accept:all`: absence of any prerequisite, approval variable, pinned SHA, target, or generated installed lock must produce nonzero exit. Before the final task replaces the guard, each acceptance command must return nonzero `REAL_ACCEPTANCE_NOT_IMPLEMENTED` after validating its guards; tests must assert that result. Test final verification rejects unless both immutable `rpi-5` and `rpi-2` release directories contain matching manifest, generated lock/image digest, checksum, and verification evidence.

- [ ] **Step 2: Run the failing tests.**

Run: `cd tools/firmware-image-builder && npm run test:workstation`

Expected: FAIL because `test:workstation`, the three deterministic tests, and the guarded acceptance commands do not exist.

- [ ] **Step 3: Implement the deterministic gate.** Configure `npm run test:workstation` to execute all three files, exactly: `test/integration/workstation.test.ts`, `test/integration/release-acceptance.test.ts`, and `test/integration/final-verification.test.ts`. `run-workstation-test.mjs` must return zero in test mode with typed unavailable results and no mutation. `accept-real-target.mjs` must validate Node, Docker, SSH origin, user systemd, generated production lock/image, approved root, native publisher, and `renameat2`; it must exit nonzero before mutation when any is missing, and otherwise exit nonzero with `REAL_ACCEPTANCE_NOT_IMPLEMENTED` until Task 35 replaces the implementation. Require `OSI_IMAGE_BUILDER_REAL=1`, `OSI_IMAGE_BUILDER_APPROVED_ROOT_ID`, a pinned full SHA, and one target. This task defines deterministic tests and guards only; it does not claim real-image acceptance.

- [ ] **Step 4: Run the identical command.**

Run: `cd tools/firmware-image-builder && npm run test:workstation`

Expected: PASS with all three test files executed, typed unavailable results, zero mutation in deterministic mode, and every guarded acceptance command nonzero until Task 35.

- [ ] **Step 5: Commit.**

```bash
git add tools/firmware-image-builder/scripts/run-workstation-test.mjs tools/firmware-image-builder/scripts/accept-real-target.mjs tools/firmware-image-builder/test/integration/workstation.test.ts tools/firmware-image-builder/test/integration/release-acceptance.test.ts tools/firmware-image-builder/test/integration/final-verification.test.ts tools/firmware-image-builder/package.json tools/firmware-image-builder/README.md
git commit -m "test: add deterministic workstation acceptance guards"
```

### Task 35: Run mandatory real Pi 5 and Pi 4 acceptance

**Files:**
- Create: `tools/firmware-image-builder/test/integration/real-acceptance.test.ts`
- Create: `tools/firmware-image-builder/test/integration/release-report.md`
- Modify: `tools/firmware-image-builder/scripts/accept-real-target.mjs`
- Modify: `tools/firmware-image-builder/package.json`
- Modify: `tools/firmware-image-builder/README.md`

- [ ] **Step 1: Write the failing test.** Test that `accept:all` requires a generated installed production lock and image, `OSI_IMAGE_BUILDER_REAL=1`, an approved root, a pinned full SHA, and a real SSH origin. Test that a lock with `schemaVersion: "1"`, `schemaVersion: 0`, or any non-integer schema version is rejected. For each target, the report supplies `release_dir`, the canonical non-symlink `job_evidence_root` at `<state-root>/jobs/<job-id>/evidence`, `worktree`, `rootfs`, `target_output`, `target_id`, `target_manifest_json`, `build_start_epoch`, `source_flows`, `source_db`, `source_gui`, `feed_gui`, `build_manifest`, `installed_lock`, `docker_inspection_json`, `published_verification_json`, `published_sha256sums`, and `report_json`; `published_verification_json` must be the aggregation at `release_dir/verification.json`. Derive the ten evidence paths from that published aggregation and the fixed stage schema, never from a caller-provided list. Test exact rejection vectors for an absolute path, empty path, `.`, `..`, backslash, unexpected filename, unexpected stage, duplicate stage/path, symlink component, and root escape; test acceptance only for the ten exact stage/path pairs. Test a directory/file-component swap between validation and callback read/hash: `withNoFollowFileUnderRoot()` must either read the original bytes through handles opened before the swap or reject the swap, and must never reopen a returned pathname. Test that the one-process evidence validator parses the aggregation, opens every accepted path under `job_evidence_root` with held handles, validates and hashes all ten files, compares the report's stable relative keys, and emits only observation/digest JSON. Derive the exact artifact pattern from the target manifest and run these independent commands, capturing each result:

After both target jobs, the aggregate report supplies `rpi5_report_json` and `rpi2_report_json` for the cross-target identity check below.

```bash
test "$build_manifest" = "$release_dir/build-manifest.json"
test -f "$build_manifest"
test "$published_verification_json" = "$release_dir/verification.json"
test -f "$published_verification_json"
test -d "$job_evidence_root"
test ! -L "$job_evidence_root"

# Parse the published aggregation and validate/hash all ten evidence files in
# one process. The helper holds root, component, and file handles throughout
# each callback; stdout contains only observations and digests, never paths to
# reopen through another process.
stage_evidence_observations="$(node --import tsx --input-type=module - "$job_evidence_root" "$published_verification_json" "$report_json" <<'NODE'
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { withNoFollowFileUnderRoot } from './domain/paths.ts';

const [jobEvidenceRoot, publishedVerificationJson, reportJson] = process.argv.slice(2);
const fixed = [
  ['preflight', '00-preflight.json'], ['source', '01-source.json'],
  ['release-gates', '02-release-gates.json'], ['frontend', '03-frontend.json'],
  ['target-setup', '04-target-setup.json'], ['feeds', '05-feeds.json'],
  ['config', '06-config.json'], ['build', '07-build.json'],
  ['verify', '08-verify.json'], ['publish', '09-publish.json'],
];
const fixedByPath = new Map(fixed.map(([stage, relative]) => [relative, stage]));
const invalidRelative = relative => typeof relative !== 'string' || relative.length === 0 || relative === '.' || relative === '..' || relative.startsWith('/') || relative.includes('\\') || relative.split('/').includes('..');
const aggregation = JSON.parse(await readFile(publishedVerificationJson, 'utf8'));
const entries = aggregation.observations?.stageEvidence;
const reject = () => { throw new Error('evidence validation failed'); };
if (!Array.isArray(entries) || entries.length !== fixed.length) reject();
const seen = new Set();
for (const entry of entries) {
  if (!entry || typeof entry.stage !== 'string' || invalidRelative(entry.path) || fixedByPath.get(entry.path) !== entry.stage || seen.has(entry.path)) reject();
  seen.add(entry.path);
}
if (seen.size !== fixed.length || fixed.some(([, relative]) => !seen.has(relative))) reject();

const stageEvidenceSha256 = {};
const stageObservations = {};
for (const [stage, relative] of fixed) {
  const result = await withNoFollowFileUnderRoot(jobEvidenceRoot, relative, async file => {
    const bytes = await file.readFile();
    const evidence = JSON.parse(bytes.toString('utf8'));
    if (evidence.stage !== stage) reject();
    return { sha256: createHash('sha256').update(bytes).digest('hex'), observations: evidence.observations ?? {} };
  });
  stageEvidenceSha256[relative] = result.sha256;
  stageObservations[stage] = result.observations;
}
const report = JSON.parse(await readFile(reportJson, 'utf8'));
const reportEvidence = report.observations?.stageEvidenceSha256;
if (!reportEvidence || Object.keys(reportEvidence).length !== fixed.length || fixed.some(([, relative]) => reportEvidence[relative] !== stageEvidenceSha256[relative]) || Object.keys(reportEvidence).some(relative => !fixedByPath.has(relative))) reject();
const source = stageObservations.source;
const verify = stageObservations.verify;
const freshnessStatus = verify.freshnessStatus;
if (source.targetOutputAbsent !== true || !['fresh', 'advanced', 'unknown'].includes(freshnessStatus) || (freshnessStatus === 'advanced' && verify.newerSourceAvailable !== true) || (freshnessStatus === 'unknown' && verify.newerSourceAvailable === true)) reject();
process.stdout.write(JSON.stringify({ observations: { stageEvidenceSha256, sourceEvidenceSha256: stageEvidenceSha256['01-source.json'], verifyEvidenceSha256: stageEvidenceSha256['08-verify.json'], targetOutputAbsent: source.targetOutputAbsent, freshnessStatus, newerSourceAvailable: verify.newerSourceAvailable === true } }));
NODE
)"
test -n "$stage_evidence_observations"
source_evidence_sha256="$(node -e "const o = JSON.parse(process.argv[1]).observations; process.stdout.write(o.sourceEvidenceSha256);" "$stage_evidence_observations")"
verify_evidence_sha256="$(node -e "const o = JSON.parse(process.argv[1]).observations; process.stdout.write(o.verifyEvidenceSha256);" "$stage_evidence_observations")"

# Release cardinality, freshness, size, checksum, and gzip. The image is
# directly under the release root and both locations use the exact manifest glob.
artifact_pattern="$(node -e "const m = JSON.parse(require('fs').readFileSync(process.argv[1])); process.stdout.write(m.artifactGlob);" "$target_manifest_json")"
mapfile -t images < <(find "$release_dir" -maxdepth 1 -type f -name "$artifact_pattern" -print)
mapfile -t target_images < <(find "$target_output" -maxdepth 1 -type f -name "$artifact_pattern" -print)
test "${#images[@]}" -eq 1
test "${#target_images[@]}" -eq 1
image="${images[0]}"
test "$(basename "${target_images[0]}")" = "$(basename "$image")"
test "$(stat -c %Y "$image")" -gt "$build_start_epoch"
test "$(stat -c %s "$image")" -ge 67108864
test "$published_sha256sums" = "$release_dir/sha256sums"
test -f "$published_sha256sums"
awk 'NF {n++} END {exit !(n == 1)}' "$published_sha256sums"
awk -v name="$(basename "$image")" 'NF {if (NF != 2 || $2 != name) exit 1; n++} END {exit !(n == 1)}' "$published_sha256sums"
(cd "$release_dir" && sha256sum -c sha256sums)
gzip -t "$image"

# Every repository release verifier is independent, mandatory, and runs with
# the pinned build worktree as its current directory.
(cd "$worktree" && node scripts/verify-profile-parity.js)
(cd "$worktree" && node scripts/verify-chameleon-calibration.js)
(cd "$worktree" && node scripts/verify-db-schema-consistency.js)
(cd "$worktree" && node scripts/verify-sync-flow.js)
(cd "$worktree" && node scripts/verify-strega-gen1.js)
(cd "$worktree" && node scripts/verify-communication-contract.js)
(cd "$worktree" && scripts/check-mqtt-topics.sh)
# The target directory and every config symbol are target-specific exact checks.
case "$target_id" in
  rpi-5)
    (cd "$worktree/openwrt/bin/targets/bcm27xx/bcm2712" && sha256sum -c sha256sums)
    grep -Fx 'CONFIG_TARGET_bcm27xx_bcm2712=y' "$worktree/openwrt/.config"
    grep -Fx 'CONFIG_TARGET_PROFILE="DEVICE_rpi-5"' "$worktree/openwrt/.config"
    ;;
  rpi-2)
    (cd "$worktree/openwrt/bin/targets/bcm27xx/bcm2709" && sha256sum -c sha256sums)
    grep -Fx 'CONFIG_TARGET_bcm27xx_bcm2709=y' "$worktree/openwrt/.config"
    grep -Fx 'CONFIG_TARGET_PROFILE="DEVICE_rpi-2"' "$worktree/openwrt/.config"
    ;;
  *) exit 1 ;;
esac
grep -Fx 'CONFIG_TARGET_ROOTFS_PARTSIZE=14336' "$worktree/openwrt/.config"
grep -Fx 'CONFIG_PACKAGE_node-red=y' "$worktree/openwrt/.config"
grep -Fx 'CONFIG_PACKAGE_node-red-contrib-chirpstack=y' "$worktree/openwrt/.config"
grep -Fx 'CONFIG_PACKAGE_chirpstack=y' "$worktree/openwrt/.config"
grep -Fx 'CONFIG_PACKAGE_node-red-node-sqlite=y' "$worktree/openwrt/.config"

# Required rootfs files and manifests.
test -f "$rootfs/etc/uci-defaults/98_osi_node_red_seed"
test -f "$rootfs/usr/share/flows.json"
test -f "$rootfs/usr/share/db/farming.db"
test -f "$rootfs/etc/init.d/node-red"
test -f "$rootfs/usr/lib/node-red/gui/index.html"
test -f "$rootfs/usr/share/node-red/node_modules/@grpc/grpc-js/package.json"
test -f "$rootfs/usr/share/node-red/node_modules/@chirpstack/chirpstack-api/package.json"
test -f "$rootfs/usr/share/node-red/node_modules/google-protobuf/package.json"
test -f "$rootfs/usr/share/node-red/node_modules/protobufjs/package.json"
test -f "$rootfs/usr/share/node-red/node_modules/osi-lib/package.json"
test -f "$rootfs/usr/share/node-red/node_modules/osi-db-helper/package.json"
test -f "$rootfs/usr/share/node-red/node_modules/osi-chirpstack-helper/package.json"

# Nginx routes are checked separately.
grep -Eq '^[[:space:]]*location[[:space:]]+/gui/' "$rootfs/etc/nginx/conf.d/node-red.locations"
grep -Eq '^[[:space:]]*location[[:space:]]+/auth/' "$rootfs/etc/nginx/conf.d/node-red.locations"
grep -Eq '^[[:space:]]*location[[:space:]]+/api/' "$rootfs/etc/nginx/conf.d/node-red.locations"
grep -Eq '^[[:space:]]*location[[:space:]]+/download/' "$rootfs/etc/nginx/conf.d/node-red.locations"

# GUI title and recursive payload hash must match the feed mirror.
test "$(grep -m1 -o '<title>[^<]*</title>' "$rootfs/usr/lib/node-red/gui/index.html")" = "$(grep -m1 -o '<title>[^<]*</title>' "$feed_gui/index.html")"
hash_tree() { (cd -- "$1" && find . -type f -printf './%P\0' | LC_ALL=C sort -z | while IFS= read -r -d '' rel; do rel="${rel#./}"; sha256sum -- "$rel"; done); }
cmp <(hash_tree "$feed_gui") <(hash_tree "$rootfs/usr/lib/node-red/gui")

# Critical source payloads must match their packaged rootfs payloads.
test "$(sha256sum "$source_flows" | awk '{print $1}')" = "$(sha256sum "$rootfs/usr/share/flows.json" | awk '{print $1}')"
test "$(sha256sum "$source_db" | awk '{print $1}')" = "$(sha256sum "$rootfs/usr/share/db/farming.db" | awk '{print $1}')"
cmp <(hash_tree "$source_gui") <(hash_tree "$rootfs/usr/lib/node-red/gui")
tree_sha256() { hash_tree "$1" | sha256sum | awk '{print $1}'; }
published_sha256sums_sha256="$(sha256sum "$published_sha256sums" | awk '{print $1}')"
published_verification_sha256="$(sha256sum "$published_verification_json" | awk '{print $1}')"
source_flows_sha256="$(sha256sum "$source_flows" | awk '{print $1}')"
rootfs_flows_sha256="$(sha256sum "$rootfs/usr/share/flows.json" | awk '{print $1}')"
source_db_sha256="$(sha256sum "$source_db" | awk '{print $1}')"
rootfs_db_sha256="$(sha256sum "$rootfs/usr/share/db/farming.db" | awk '{print $1}')"
feed_gui_tree_sha256="$(tree_sha256 "$feed_gui")"
source_gui_tree_sha256="$(tree_sha256 "$source_gui")"
rootfs_gui_tree_sha256="$(tree_sha256 "$rootfs/usr/lib/node-red/gui")"

# SQLite integrity and the allowed zero-row Chameleon case.
node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') process.exit(1); const row = db.prepare('SELECT COUNT(*) AS count FROM chameleon_calibrations').get(); if (!Number.isInteger(row.count)) process.exit(1); console.log(row.count); db.close();" "$rootfs/usr/share/db/farming.db"

# Node resolution from the rootfs Node-RED directory, including both OSI helpers.
node -e "for (const name of ['protobufjs','@grpc/grpc-js','@chirpstack/chirpstack-api','google-protobuf','osi-lib','osi-db-helper','osi-chirpstack-helper']) console.log(require.resolve(name, { paths: [process.argv[1]] }))" "$rootfs/usr/share/node-red"

# Source absence and final freshness were validated by the held-handle
# evidence process above; no evidence pathname is reopened here.
node -e "const o = JSON.parse(process.argv[1]).observations; if (o.targetOutputAbsent !== true || !['fresh','advanced','unknown'].includes(o.freshnessStatus)) process.exit(1);" "$stage_evidence_observations"

# The installed lock and builder image must be real and mutually consistent
# with the build manifest and structured Docker inspection evidence.
node -e "const fs = require('fs'); const crypto = require('crypto'); const lock = JSON.parse(fs.readFileSync(process.argv[1])); const manifest = JSON.parse(fs.readFileSync(process.argv[2])); const lockHash = crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'); const digestKeys = ['imageDigest','baseImageDigest','dockerfileSha256','executionDefinitionSha256','validationEvidenceSha256']; const stringKeys = ['packageVersion','imageRepository','baseImage','nodeVersion']; const exactKeys = ['schemaVersion','packageVersion','imageRepository','imageDigest','baseImage','baseImageDigest','dockerfileSha256','packageSet','rustConfig','nodeVersion','executionDefinitionSha256','validationEvidenceSha256']; const allowedKeys = new Set([...exactKeys, 'installable', 'publisherSha256', 'imageId']); if (lock.installable !== true) process.exit(1); if (lock.schemaVersion !== 1 || !Number.isInteger(lock.schemaVersion)) process.exit(1); if (Object.keys(lock).some(key => !allowedKeys.has(key))) process.exit(1); for (const key of digestKeys) if (!/^[0-9a-f]{64}$/.test(lock[key])) process.exit(1); for (const key of stringKeys) if (typeof lock[key] !== 'string' || lock[key].length === 0) process.exit(1); if (!Array.isArray(lock.packageSet) || lock.packageSet.length === 0 || !lock.rustConfig || typeof lock.rustConfig !== 'object') process.exit(1); if (lock.publisherSha256 !== undefined && !/^[0-9a-f]{64}$/.test(lock.publisherSha256)) process.exit(1); if (lock.imageId !== undefined && !/^[0-9a-f]{64}$/.test(lock.imageId)) process.exit(1); const canonical = lock.imageRepository + '@sha256:' + lock.imageDigest; if (!/^.+@sha256:[0-9a-f]{64}$/.test(canonical) || lock.imageRepository.includes('@')) process.exit(1); for (const key of exactKeys) if (!(key in manifest) || JSON.stringify(manifest[key]) !== JSON.stringify(lock[key])) process.exit(1); if (manifest.builderLockSha256 !== lockHash || manifest.canonicalImageRef !== canonical) process.exit(1);" "$installed_lock" "$build_manifest"
canonical_image_ref="$(node -e "const l = JSON.parse(require('fs').readFileSync(process.argv[1])); process.stdout.write(l.imageRepository + '@sha256:' + l.imageDigest);" "$installed_lock")"
docker image inspect --format '{"Id":"{{.Id}}","RepoDigests":{{json .RepoDigests}}}' "$canonical_image_ref" > "$docker_inspection_json"
node -e "const fs = require('fs'); const lock = JSON.parse(fs.readFileSync(process.argv[1])); const inspected = JSON.parse(fs.readFileSync(process.argv[2])); const canonical = lock.imageRepository + '@sha256:' + lock.imageDigest; if (!Array.isArray(inspected.RepoDigests) || !inspected.RepoDigests.includes(canonical)) process.exit(1); if (lock.imageId !== undefined && inspected.Id !== 'sha256:' + lock.imageId) process.exit(1);" "$installed_lock" "$docker_inspection_json"
node -e "const fs = require('fs'); const crypto = require('crypto'); const r = JSON.parse(fs.readFileSync(process.argv[1])); const lock = JSON.parse(fs.readFileSync(process.argv[7])); const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); const lockHash = digest(process.argv[2]); const manifestHash = digest(process.argv[3]); const imageHash = digest(process.argv[4]); const inspectHash = digest(process.argv[5]); const targetManifestHash = digest(process.argv[6]); const keys = ['installedLockSha256','buildManifestSha256','publishedImageSha256','dockerInspectionSha256','targetManifestSha256','publishedSha256sumsSha256','publishedVerificationSha256','sourceEvidenceSha256','verifyEvidenceSha256','sourceFlowsSha256','rootfsFlowsSha256','sourceDbSha256','rootfsDbSha256','feedGuiTreeSha256','sourceGuiTreeSha256','rootfsGuiTreeSha256']; const expected = {publishedSha256sumsSha256: process.argv[8], publishedVerificationSha256: process.argv[9], sourceEvidenceSha256: process.argv[10], verifyEvidenceSha256: process.argv[11], sourceFlowsSha256: process.argv[12], rootfsFlowsSha256: process.argv[13], sourceDbSha256: process.argv[14], rootfsDbSha256: process.argv[15], feedGuiTreeSha256: process.argv[16], sourceGuiTreeSha256: process.argv[17], rootfsGuiTreeSha256: process.argv[18]}; for (const key of keys) if (!/^[0-9a-f]{64}$/.test(r.observations?.[key])) process.exit(1); if (r.observations?.installedLockPath !== process.argv[2] || r.observations?.canonicalImageRef !== lock.imageRepository + '@sha256:' + lock.imageDigest) process.exit(1); if (r.observations.installedLockSha256 !== lockHash || r.observations.buildManifestSha256 !== manifestHash || r.observations.publishedImageSha256 !== imageHash || r.observations.dockerInspectionSha256 !== inspectHash || r.observations.targetManifestSha256 !== targetManifestHash || r.observations.imageDigest !== lock.imageDigest || (lock.imageId !== undefined && r.observations.imageId !== lock.imageId)) process.exit(1); for (const [key, value] of Object.entries(expected)) if (r.observations[key] !== value) process.exit(1);" "$report_json" "$installed_lock" "$build_manifest" "$image" "$docker_inspection_json" "$target_manifest_json" "$installed_lock" "$published_sha256sums_sha256" "$published_verification_sha256" "$source_evidence_sha256" "$verify_evidence_sha256" "$source_flows_sha256" "$rootfs_flows_sha256" "$source_db_sha256" "$rootfs_db_sha256" "$feed_gui_tree_sha256" "$source_gui_tree_sha256" "$rootfs_gui_tree_sha256"
```

After both target jobs, the aggregate command compares the two target reports and rejects any mismatch in the installed lock or builder image:

```bash
node -e "const fs = require('fs'); const a = JSON.parse(fs.readFileSync(process.argv[1])).observations; const b = JSON.parse(fs.readFileSync(process.argv[2])).observations; for (const key of ['installedLockSha256','imageDigest','canonicalImageRef']) if (a[key] !== b[key]) process.exit(1); if ((a.imageId ?? null) !== (b.imageId ?? null)) process.exit(1);" "$rpi5_report_json" "$rpi2_report_json"
```

Test that a missing command, failed checksum/gzip/config/rootfs/dependency/database/hash/route/SQLite check, wrong image mtime or size, wrong artifact cardinality, missing generated lock/image, non-installable lock, non-64-hex digest, Docker identity mismatch, missing published verification or checksum evidence, missing stage-evidence hash, any source/verify/target/Docker/flow/database/GUI hash mismatch, report hash omission, mismatched target reports, missing immutable release directory, missing `observations.targetOutputAbsent`, or invalid `observations.freshnessStatus` causes nonzero acceptance.

- [ ] **Step 2: Run the failing test and aggregate gate.**

Run: `cd tools/firmware-image-builder && npm run check && npm exec vitest run -- test/integration/real-acceptance.test.ts && npm run accept:all`

Expected: FAIL until the real acceptance command and its complete verification report exist. On an unconfigured workstation, `accept:all` must exit nonzero before mutation; that is a guard failure, not a passing acceptance.

- [ ] **Step 3: Implement and execute real acceptance.** Replace the Task 34 guard-only `REAL_ACCEPTANCE_NOT_IMPLEMENTED` path. `accept-real-target.mjs` must verify the installed generated lock and image digest, require the real approval variables, and exit nonzero before mutation when any prerequisite is absent. It must run Pi 5 first with `accept:pi5`, verify its immutable release directory and all independent commands above, then run Pi 4/400/3/2 with `accept:pi4` and verify its corresponding target/rootfs commands. The stage-evidence command must remain one process: it parses `release_dir/verification.json`, validates the fixed ten stage/path pairs, uses `withNoFollowFileUnderRoot()` for every read/validation/hash while handles remain held, compares stable relative report keys, and emits only observation/digest JSON; no pathname from that process may be reopened by shell, `sha256sum`, or another Node process. It must capture the generated lock hash, image digest, canonical image reference, optional image ID, Docker inspection identity, build-manifest hash, target-manifest hash, published checksum and verification hashes, source and verify evidence hashes, every stage-evidence hash, source/rootfs flow and database hashes, feed/source/rootfs GUI-tree hashes, source SHA, target/profile/config hashes, image size/mtime/SHA, freshness status, `observations.targetOutputAbsent`, and every stage evidence file in `release-report.md`; the two target reports must prove the same installed lock hash, image digest, canonical reference, and optional image ID. `accept:all` must return zero only after both real image builds pass, all checks pass for both images, both target manifests agree on the installed lock/image, and both immutable verified release directories exist. Do not flash, format, or write any block device.

- [ ] **Step 4: Run the identical tests and mandatory acceptance.**

Run: `cd tools/firmware-image-builder && npm run check && npm exec vitest run -- test/integration/real-acceptance.test.ts && npm run accept:all`

Expected: PASS only when `npm run check`, the real-acceptance test, and `accept:all` all return zero; Pi 5 and Pi 4/400/3/2 real builds both finish successfully; all independent verification commands pass for both images; the installed generated lock/image matches both manifests; and both immutable release directories exist. Any nonzero command blocks Task 35 completion and blocks its commit.

- [ ] **Step 5: Commit only after real acceptance.**

```bash
git add tools/firmware-image-builder/test/integration/real-acceptance.test.ts tools/firmware-image-builder/test/integration/release-report.md tools/firmware-image-builder/scripts/accept-real-target.mjs tools/firmware-image-builder/package.json tools/firmware-image-builder/README.md
git commit -m "test: record both real target image acceptances"
```

## Spec coverage map

Every approved spec section has an implementing task.

| Spec section | Tasks |
| --- | --- |
| 1 Problem | Tasks 1, 9, 11, 12, 14-17, 28, 35 |
| 2 Goals | Tasks 2-35 |
| 3 Non-goals | Tasks 8, 13, 31, 35 |
| 4 Terms | Tasks 3, 4, 8, 20-22 |
| 5 Architecture and ownership | Tasks 1, 6, 7, 12, 18-33 |
| 6 Source selection and pinning | Tasks 9, 10, 14, 16 |
| 7 Declarative manifest | Tasks 4, 12, 15, 16 |
| 8 Persistent storage, retention, output layout | Tasks 2, 5-8, 13, 27 |
| 9 State machine and actor matrix | Tasks 3, 6, 7, 17-35 |
| 10 Pipeline and stage evidence | Tasks 12, 14-17, 28, 35 |
| 11 Queue, cancellation, restart | Tasks 18-29, 34 |
| 12 API and SSE | Tasks 9, 10, 19, 28, 29, 31, 33 |
| 13 UX | Tasks 30, 32 |
| 14 Error taxonomy and recovery | Tasks 3, 9, 10, 16, 18-35 |
| 15 Security and destructive actions | Tasks 2, 7-13, 19-26, 29, 31, 33-35 |
| 16 Testing strategy | Tasks 1, 5-7, 11-16, 18-22, 23-35 |
| 17 Acceptance criteria | Matrix below |
| 18 Observability and operations | Tasks 27-32, 34 |
| 19 Packaging and systemd installation | Tasks 24, 25, 33 |
| 20 Implementation review checklist | Final review below and every task review |

## Acceptance criteria matrix

| Criterion | Tasks and evidence | Test boundary |
| --- | --- | --- |
| 1 preflight | Tasks 10 and 29; `preflight.test.ts`, `api.test.ts` | Fake API plus generated-lock probe |
| 2 SHA pin and branch movement | Task 9; `source-resolver.test.ts` | Fake Git |
| 3 fetched origin branches only | Tasks 9, 29, 32 | Fake API and browser fixture |
| 4 durable job metadata | Tasks 5, 6, 14, 16, 17, 35 | Temporary SQLite, fixture worktree, real report |
| 5 dirty checkout isolation | Task 14; `source-worktree.test.ts` | Fixture Git |
| 6 actor ownership, fences, credentials, admissions | Tasks 7, 20-22 | Fake store/systemd/Docker and crash fixtures |
| 7 FIFO and one runner | Tasks 23, 26, 27 | Fake systemd and startup fixture |
| 8 restart, reboot blocker, browser independence | Tasks 19, 22-26, 28, 32 | Fake lifecycle, browser fixture, workstation guard |
| 9 Docker protocol and exact cleanup | Tasks 12, 18, 20-22 | Fake Docker plus deterministic Docker integration result |
| 10 source/feed/config sequence | Tasks 14 and 15 | Fixture worktree and fake operations |
| 11 immutable builder/toolchain | Tasks 11, 12, 25, 33, 35 | Lock tests plus real installed image |
| 12 listed gates and frontend | Tasks 15, 17, 30, 35 | Fake operations plus both real target builds |
| 13 output absence, feed links, floor | Tasks 14-16 | Fixture output and artifact fixtures |
| 14 cardinality and checksums | Tasks 13, 16, 17, 35 | Native Linux publisher and both images |
| 15 rootfs and runtime verification | Tasks 16 and 35 | Rootfs fixture and real artifacts |
| 16 zero Chameleon rows | Task 16 and 35 | SQLite fixture and both rootfs checks |
| 17 final freshness | Tasks 9, 10, 16, 29, 35 | Fake resolver plus SSH workstation check |
| 18 cancellation and recovery | Tasks 18-22, 32 | Separate fake jobs and both crash windows |
| 19 atomic publication | Tasks 8, 13, 16, 17, 22 | Native Linux integration |
| 20 API/security constraints | Tasks 2, 7, 9, 12, 13, 19, 24-26, 29, 31, 33-35 | Static policy and fake API |
| 21 systemd install and independence | Tasks 24 and 33 | Unit templates and versioned installer |
| 22 retention | Task 27 | Temporary state/output roots |
| 23 direct Docker definition | Tasks 11, 12, 32, 33, 35 | Static definition plus Docker integration |
| 24 full test and real target acceptance | Tasks 32 and 35 | Full fake/browser suite plus both real image builds |

## Review and self-check gates

After each task, the Luna implementer reports the exact Step 2/Step 4 command,
its failing/pass output, changed paths, and commit ID to Sol for spec and code
quality review. Required findings return to the same task before the next task
starts. No task may import a file that is first created by a later task.

The final independent review inspects every filesystem write, state transition,
subprocess argv/environment, error path, recovery race, output collision, feed
reinstall order, builder derivation and generated-lock validation, GUI/rootfs
hash comparison, same-origin write validation, and production/cloud access
guard.

Before handoff, run from the repository root:

```bash
cd /home/phil/Repos/osi-os/.worktrees/firmware-image-builder
node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/specs/2026-07-22-firmware-image-builder-design.md
node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-07-22-firmware-image-builder.md
node tools/firmware-image-builder/scripts/check-plan-policy.mjs docs/superpowers/plans/2026-07-22-firmware-image-builder.md
git diff --check
```

The final task cannot be marked complete after preflight alone. It requires
both sequential real image builds, all independent verification commands for
both targets, both immutable verified release directories, and the release
report with the generated installed lock and image evidence.
