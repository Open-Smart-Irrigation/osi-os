# Refactor boundary hardening implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extracted Node-RED behavior deploy and roll back as one sealed, gateway-personalized release, make the execution controller honor repository, target, and database compatibility without false recovery claims, and prove every configurable runtime value reaches the Node-RED process environment.

**Architecture:** Build a portable source release containing `flows.template.json`, local helper packages, codecs, channel manifest, settings, and the GUI. On the gateway, personalize the template into `flows.json` from non-secret UCI-derived identity and Agroscope values, install dependencies, then seal the complete runtime release. A single `/srv/node-red/payloads/current` symlink selects that sealed unit; mutable credentials and the farming database remain outside it, and startup never mutates a selected release. The pipeline resolves each bundle's repository and target before mutation, classifies pending migration rollback compatibility, uses a typed recovery result, and stops explicitly when payload selection, required database restoration, or an external deployment cannot be proved. Contract verifiers connect UCI defaults, init resolution, process exports, and flow consumers.

**Tech Stack:** Node.js 22 and `node:test`, POSIX `sh` on OpenWrt, Python 3 dataclasses and pytest, Node-RED, npm, SQLite, GitHub Actions.

## Global constraints

- “Persistent `/data` mount” is the nearest covering mount, not necessarily a dedicated `/data` entry. Accept the maintained OpenWrt writable-root overlay only from reviewed bcm2709/bcm2712/Kaba100 `mountinfo` fixtures whose upperdir/backing block device is persistent and whose `/data` has no nearer bind/overlay shadow. Reject tmpfs/ramfs, volatile upperdirs, nested overlays, bind shadows, ambiguous backing, and fixture drift.

- `/data/osi-deploy` is the sole durable gateway control root. The maintained profiles disable persistent `/var`, so no journal, receipt, selector intent, conversion generation, marker, or retained recovery artifact may live there. Require root-owned 0700 directories, 0600 records, no symlink component, a `realpath` under persistent `/data`, and mount/filesystem evidence that rejects tmpfs, ramfs, and volatile aliases. `/var/lock/osi-deploy.lock.d` is intentionally only the same-boot lock. Reboot tests erase `/var` and retain every durable control fact.
- A pre-arm staged artifact is inert and never reusable. Once its immutable claim exists, an old-role start or process-generation change makes that attempt unsafe and non-resumable; controller restart or reboot with every guarded rc link absent may resume only when no old-role generation appeared. Abandonment first restores and verifies its prior live topology, then exclusively publishes and fsyncs the abandonment receipt, and only then removes that attempt's inert staging under the gateway lock. A crash before receipt publication resumes restoration; the receipt, not staging absence, consumes the claim.

- Execute this plan as Train B in `2026-07-15-refactor-repair-program.md`, only after the integrated Train A edge repairs are merged and their Kaba100 soak is accepted.
- Execute `2026-07-15-sync-delivery-stop-loss.md` first, then `2026-07-15-lsn50-writer-runtime-recovery.md` and `2026-07-15-chirpstack-device-reconciliation.md`. Rebase this plan after their flow, pipeline timestamp, and bootstrap-helper changes land.
- The Device API plan may land after the sync stop-loss plan and before this plan. Preserve its explicit 401 route policy and executable CI test.
- The OSI OS half of `2026-07-15-cross-repo-sync-contract-ci.md` lands with or immediately after sync stop-loss. Its OSI Server vendor/CI half is a separate repository change and must be green before any paired server rollout, but it does not block local writer or Device API repairs.
- Work from current `main`; confirm `HEAD == origin/main` before implementation.
- Base every slice on `origin/main` containing merged [OSI OS PR #146](https://github.com/Open-Smart-Irrigation/osi-os/pull/146), merge commit `f50950b1767a1aa6302ef2553d68a4e379b5b142` or a reviewed descendant. Preserve its four role-specific lifecycle owners: `osi-db-integrity` one-shot at S90, `osi-identityd` procd daemon at S98/K98, Node-RED procd service at S99/K99, and `osi-bootstrap` one-shot at S99. Identityd quiesces before Node-RED; bootstrap/integrity require bounded child-absence proof, not a fake stop. Quarantine all six links in identityd S98/K98, Node-RED S99/K99, bootstrap S99, integrity S90 order; install/verify permanent guard-aware `94_osi_identityd_enable` and never restore legacy bytes. Restore/start Node-RED before identityd; restore identityd last, wait ready, then separately prove no pending restart. Preserve the seven sentinel-gated builders, `sys-stats-fn`, coordinated restart ownership, GUI status/banner contract, and the exact merged lifecycle test union.
- Do not access `osicloud.ch`. The only live target allowed by this plan is the Kaba100 demo gateway, after the local gates pass.
- Never replace `/data/db/farming.db` with a bundled seed. Database migration and byte-image restore remain owned by `lib/osi-migrate` and the existing live-ops procedures.
- Keep `/srv/node-red/flows_cred.json`, `/srv/node-red/.chirpstack.env`, gateway identity state, `/data/osi-sync/protocol-capabilities/`, independent service-owned `/data/osi-sync-witness/{protocol-capability-witnesses,command-activity-witnesses,command-activity-head-witnesses}/`, and `/data/db/` outside the immutable release. Back up the capability, capability-witness, activity-database, and activity-head roots for evidence, but never restore, delete, or downgrade them during payload/database rollback; only the stop-loss checkpoint protocol may prune bounded activity rows. A damaged/mismatched generation, witness, checkpoint, or head blocks command polling until reviewed recovery succeeds.
- Never put Agroscope usernames, passwords, MQTT passwords, tokens, or other secrets in `release.json`, `gateway-personalization.json`, `runtime-seal.json`, or `flows.json`.
- Treat `bcm2712` as the repository edit source and mirror changed profile payload files byte-for-byte to `bcm2709`; this is not runtime profile selection. Reuse Train A's artifact-owned `detect-rpi-profile.sh` as the sole live authority: exact, mutually consistent model/compatible evidence selects `bcm2712` or `bcm2709`, `GatewayConfig.profile` is only an expected-value assertion, and missing, unknown, conflicting, or mismatched evidence fails before claim or staging. Bind the detected profile, hardware-evidence hash, expected profile, and exact merged selected live-control mapping through the artifact, claim, backup, state, receipts, and evidence.
- Keep `deploy.sh` compatible with BusyBox `ash`: POSIX syntax only, no arrays, process substitution, or Bash conditionals. BusyBox execution is mandatory in local and CI deploy-boundary suites. Every owning workflow, including the Train A `.github/workflows/verify-sync-flow.yml` leg and Train B `.github/workflows/migrations.yml`/`pipeline.yml` legs, installs `busybox-static`, records `busybox --help` output, proves `busybox ash` executes, and places those steps before every required mode. The wiring guard removes each provision/proof/order fact independently; no runner-image default counts.
- Edit `flows.json` only if an executable release-path test proves it is necessary. Use the guarded script workflow and mirror both profiles.
- Do not add a generic plugin or deployment framework. The known execution kinds are an OSI OS gateway and an external OSI Server handoff.
- A failed or unexecuted check never counts as PASS. Tests must include a negative control that proves each new guard can fail.
- Preserve current runtime defaults while plumbing them through UCI: outbox retention 30 days, outbox maximum 50,000 rows, raw health retention 14 days, and hourly health retention 365 days.

---

## Confirmed gaps covered by this plan

| Boundary | Current behavior | Required behavior |
|---|---|---|
| Release | Only `flows.json` is versioned; helpers, settings, npm state, and GUI change in place | One release stamp selects every Node-RED behavior artifact |
| Startup mutation | `node-red.init` rewrites broker fields in `flows.json` on every start | Deploy personalizes and seals `flows.json`; startup writes credentials only and refuses a damaged selected release |
| Rollback | Pipeline restores only the database, ignores the restore result, and can report “restored” | Migration risk decides whether payload-only rollback is safe; every required payload, DB, and health leg is checked |
| Database replay safety | Restoring a pre-mutation database can erase command/effect/ACK evidence while persistent protocol state remains negotiated | Prove no post-backup command activity, or append a blocking restore generation and reconcile replay/domain evidence before live startup |
| Boot integrity | `osi-db-integrity` can quarantine the live DB and copy an older `.bak-*` before the deployment/recovery protocol owns the operation | Boot performs read-only diagnosis only; any replacement is deferred to the leased, journalled database-restore boundary |
| Target routing | `controller.py` always deploys Kaba100 from the osi-os root | Bundle repository and target are resolved before any git, backup, deploy, or SSH call |
| Resume | Completed bundle index is not advanced | Saved cursor points to the next unprocessed bundle |
| Configuration | LoRain/UC512 exports and retention controls are incomplete or hardcoded | Every consumed profile and retention value has UCI, init, process-export, and flow-consumer coverage |
| GUI flag | Edge returns `fieldJournalUxEnabled`, but the service type, normalizer, and all-false default drop it | The service boundary preserves the flag and tests wrapped, legacy, missing, and false values |
| CI coverage | Several executable guards and the Python pipeline suite are not required by workflows; the lazy-route test can skip without a build | Workflows run the guards directly, build the GUI before unit tests, and include negative controls |
| Program record | Item 5.3 is marked complete although its known full-payload revisit trigger has fired | Completion status follows executable release and rollback evidence |

## Code-quality decisions

- One release selector replaces independent live writes. Flows, helpers, dependencies, and GUI already change together, so this removes coupling drift without adding a general deployment framework.
- A portable template plus one deploy-time personalizer separates site configuration from source packaging. The runtime seal covers the generated `flows.json`, so startup cannot silently create an unversioned fourth state.
- The builder discovers `osi-*` packages from the canonical directory, but packages only their explicitly declared runtime files. New helpers enter the release when their `package.json.files` declaration and executable inventory tests identify the runtime surface; an allowlist plus secret-sentinel tests keeps tests, credentials, databases, and incidental files out.
- Recovery returns one typed result with visible legs. Migration risk is computed from the same ordered migration metadata used by the runner, so the controller cannot infer compatibility from a log line or an ignored Boolean.
- One shared command-activity witness makes “nothing happened after this backup” independently checkable. It advances before activity, so crashes create conservative false positives rather than unsafe false negatives; restore reconciliation remains a separate typed protocol state instead of another deployment Boolean.
- Runtime configuration inventory belongs in a verifier, not a second application registry. One versioned shell resolver owns UCI-first and compatibility-env precedence for deploy and init; defaults remain in UCI/init, while duplicated path knowledge gains an executable divergence guard.
- OSI Server deployment stays an external handoff. Implementing a second deployment engine is outside the observed Kaba100 safety failure and would add untested authority.

## File map

| File | Responsibility after this plan |
|---|---|
| `scripts/lib/node-red-release.js` | Shared source-manifest, runtime-seal, checksum, and verification primitives used by the builder and resident swap helper. |
| `scripts/node-red-release-cli.js` | Thin tested CLI adapter, also installed resident, for source verification, runtime sealing, and runtime verification. |
| `scripts/node-red-release-cli.test.js` | Real CLI exit/output tests, including tamper negatives; no mocked command that bypasses the library. |
| `scripts/build-node-red-release.js` | Builds and verifies the immutable release directory from canonical repo sources and a compiled GUI. |
| `scripts/build-node-red-release.test.js` | Inventory, checksum, exclusion, missing-file, and tamper tests for the release builder. |
| `scripts/extract-node-red-release-bundle.js` | Safely extracts the regular-file-only gzip/NDJSON transport into a new private staging directory. |
| `scripts/extract-node-red-release-bundle.test.js` | Traversal, link/type, duplicate, bound, checksum, mode, and partial-extraction cleanup tests. |
| `scripts/verify-deployment-control.js` | Verifies the exact-commit deployment-control manifest and every staged control/artifact byte before deploy. |
| `deployment-control.json` (generated artifact) | Binds one exact commit to the portable bundle and every executable/installable deployment-control file by SHA256. |
| `scripts/personalize-node-red-release.js` | Generates non-secret gateway-specific `flows.json` and personalization metadata inside a staged source release. |
| `scripts/personalize-node-red-release.test.js` | Determinism, validation, secret-exclusion, broker-field, and tamper tests for gateway personalization. |
| `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red-runtime-config.sh` | Shared, versioned UCI-first resolver used by deploy-time personalization and Node-RED startup. |
| `scripts/test-node-red-runtime-config-helper.sh` | UCI precedence, compatibility fallback, identity validation, forwarding, and secret-exclusion tests for the shared resolver. |
| `scripts/detect-rpi-profile.sh` and `scripts/detect-rpi-profile.test.sh` | Train A's closed live hardware-profile authority, reused by artifact construction, target assertion, deploy, resume, backup, and evidence. |
| `scripts/deploy-payload-swap.js` | Stages, activates, reconciles selection intents, reads, rolls back, and prunes full releases through one `current` symlink. |
| `scripts/deploy-payload-swap.test.js` | Full-release activation, legacy adoption, stable-link, rollback, and corrupt-release tests. |
| `scripts/node-red-release-mount.js` | Resident CLI that establishes and verifies a read-only self-bind mount for the selected sealed release before either service consumes it. |
| `scripts/node-red-release-mount.test.js` | Mountinfo, idempotency, wrong-source/target/options, reboot-remount, mutation, prune, and failure tests through an injected mount adapter. |
| `/usr/libexec/osi-deploy-compatibility-set.js` (installed runtime file) | Resident verified compatibility snapshot/restore dependency used by power-loss conversion recovery. |
| `scripts/lib/deployment-state.js` and `scripts/deployment-state-cli.js` | Train A's resident journal/receipt/lock boundary, extended here across migration, SQLite-set restore, release activation, probes, and recovery. |
| `/data/osi-deploy/deployment-state.json` and `receipts/<operation-id>.<receipt-kind>.json` (generated runtime state) | Fsynced startup inhibit, persistent deployment lease, linked sub-operation state, and exclusive-created deployment/rehearsal/recovery/acceptance receipts consumed by gateway services and controller resume. |
| `/data/osi-deploy/database-recovery-required.json`, `database-integrity-recoveries/<request-id>/`, forensic inventories, and `database-integrity-resolutions/<request-id>.json` (generated runtime state) | Non-authorizing boot corruption latch and immutable leased resolution evidence; unresolved facts block every guarded role. |
| `/data/osi-deploy/conversion/<deployment-id>/<generation>.json` and `staging/<deployment-id>/` (generated runtime state) | Immutable conversion generations and retained independently hashed recovery executables/artifacts that survive reboot. |
| `scripts/pi/run-staged-npm-ci.sh` | Runs lifecycle-bearing dependency installation as an unprivileged user inside a writable-root-bounded `ujail`, then returns control to root verification. |
| `/srv/node-red/payloads/activation-state.json` (generated runtime state) | Atomically records the active stamp, its exact predecessor, generation, and quarantined failed stamps; directory ordering is never release history. |
| `/data/osi-deploy/full-release-conversion-complete.json` (generated runtime state) | Root-only proof that the current sealed release and stable topology permit narrowed later snapshots. |
| `/data/osi-sync/protocol-capabilities/` plus independent capability and command-activity witness roots (generated runtime state) | Sync stop-loss-owned append-only negotiation, reset/disposition, database-restore, and command-activity evidence. Train B must prepare every general database replacement through this authority and may resume live startup only after a no-activity proof or a reconciled restore generation. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/.config` and `conf/full_raspberrypi_bcm27xx_bcm2709/.config` (verification inputs) | Prove `/var` is volatile in both maintained images and keep all durable control state on `/data`. |
| `deploy.sh` | Fetches one source release, personalizes and seals it, classifies migration rollback compatibility, and activates or fails closed. |
| `scripts/test-deploy-atomic-payload-wiring.js` | Proves deploy ordering and forbids behavior files from being written outside the staged release. |
| `database/migrations/ordered/PAYLOAD_ROLLBACK.json` | Checksum-bound declaration of which exact tested previous source-release hashes, if any, may run after each ordered migration. |
| `scripts/fixtures/migration-payload-compatibility/index.json` | Canonical sorted registry binding every compatibility case to one previous source-manifest hash and fixture directory. |
| `scripts/fixtures/migration-payload-compatibility/*/` | Minimal deterministic previous-release and database fixtures executed by the compatibility gate. |
| `scripts/pipeline/deploy.py` | Builds the release artifact and returns attempted, previous, and active release stamps. |
| `scripts/pipeline/config.py` | Validates repository, execution owner, deployment target, required expected hardware profile, recovery policy, and state cursor. |
| `scripts/pipeline/controller.py` | Resolves bundle context, advances state, catches orchestration failures, and acts on typed recovery results. |
| `scripts/pipeline/restore.py` | Payload rollback, authorized demo DB restore through the protocol boundary, release-selection rehearsal, and recovery-health result assembly. |
| `scripts/pipeline/github_evidence.py` | Narrow authoritative GitHub run/deployment adapter; provider querying and normalization do not leak into controller orchestration. |
| `scripts/pipeline/evidence.py` | Writes a unique immutable evidence bundle, hashes every file, scans for secrets, and publishes its collector manifest last. |
| `scripts/pipeline/bundles.json` | Explicit target names, execution ownership, expected hardware profile assertions, and per-gateway DB recovery policy; Kaba100 declares `bcm2712`. |
| `scripts/pipeline/tests/test_config.py` | Real-config, absent/unknown profile, and wrong-repository/target validation tests. |
| `scripts/pipeline/tests/test_controller.py` | End-to-end mocked controller tests for routing, resume, exceptions, and recovery failure. |
| `scripts/pipeline/tests/test_deploy.py` | Release-stamp parsing and payload/DB recovery tests. |
| `scripts/pipeline/tests/test_github_evidence.py` | Provider timeout, double-read consistency, identity, check, environment, and normalization tests. |
| `scripts/pipeline/tests/test_evidence.py` | Immutable evidence-bundle, hash, mode, atomic-publish, secret, and tamper tests. |
| `scripts/verify-node-red-runtime-config.js` | End-to-end profile and complete `OSI_*` consumer inventory, including UCI-backed settings and explicit compatibility exemptions. |
| `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` | Verifies the selected release, writes mutable broker credentials only, and exports UCI-backed runtime settings. |
| `scripts/node-red-guarded-launch.js` and `scripts/node-red-guarded-launch.test.js` | Resident procd child wrapper; revalidates startup authority on every initial launch and respawn. |
| `scripts/flows-credentials-publish.js` and `scripts/flows-credentials-publish.test.js` | Atomically publishes validated mutable `flows_cred.json` without exposing or truncating the prior credential set. |
| `scripts/test-deploy-sh.sh` | Executes both top-level deploy modes with injected crash/failure boundaries under real POSIX shells. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap` | Uses the verified selected release's bootstrap and fails closed instead of preferring an unsealed ROM copy. |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap` | Byte-identical maintained-profile bootstrap service mirror. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-db-integrity` | Runs the service-specific startup guard, permits read-only diagnosis only, and fails closed to reviewed leased recovery instead of quarantining or restoring the database at boot. |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-db-integrity` | Byte-identical maintained-profile fail-closed database-integrity service mirror. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config` | Defines current retention and cloud REST timeout defaults as operator-visible UCI settings. |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config` | Mirrors the maintained profile's runtime defaults byte-for-byte. |
| `scripts/test-osi-server-uci-defaults.sh` | Extends the Train A kill-switch test with runtime override, validation, and idempotency cases. |
| `.github/workflows/verify-sync-flow.yml` | Runs the runtime-config contract and every maintained narrow-waist guard explicitly. |
| `scripts/test-ci-guard-wiring.js` | Train A's workflow ownership guard, extended with the complete Train B command union and mandatory BusyBox execution. |
| `.github/workflows/pipeline.yml` | Runs the Python controller/config/deploy/recovery suite in CI. |
| `.github/workflows/typecheck.yml` | Builds the GUI before unit tests so route-asset tests cannot skip. |
| `web/react-gui/src/services/api.ts` | Owns `fieldJournalUxEnabled` normalization at the API boundary. |
| `web/react-gui/src/history/useFeatureFlags.ts` | Provides an all-false feature fallback including field journal UX. |
| `web/react-gui/tests/historyFeatureFlags.test.ts` | Covers wrapped, legacy, missing, and false field-journal flags. |
| `docs/architecture/refactor-program-2026.md` | Corrected 5.3 and pipeline evidence status. |
| `AGENTS.md` | Release-unit, target-routing, rollback-result, and config-path invariants. |

### Task 1: Build one immutable Node-RED release

**Files:**

- Create: `scripts/lib/node-red-release.js`
- Create: `scripts/build-node-red-release.js`
- Create: `scripts/build-node-red-release.test.js`
- Create: `scripts/node-red-release-cli.js`
- Create: `scripts/node-red-release-cli.test.js`
- Create: `scripts/extract-node-red-release-bundle.js`
- Create: `scripts/extract-node-red-release-bundle.test.js`
- Create: `scripts/verify-deployment-control.js`
- Create: `scripts/verify-deployment-control.test.js`
- Modify: canonical and mirrored `conf/.../node-red/osi-*/package.json` files that lack an exact runtime `files` declaration

**Interfaces:**

- Produces: `runtimeEntries(repoRoot, guiBuildDir) -> Array<{ source: string, destination: string }>`.
- Produces: `buildGuiFromExactWorktree(repoRoot) -> { distDir: string, packageLockSha256: string }`, requiring the GUI source and output to remain under the same detached exact-commit worktree.
- Produces: `buildRelease({ repoRoot, guiBuildDir, outputDir }) -> { manifestPath: string, fileCount: number }`.
- Produces: `writeSourceManifest(outputDir) -> { manifestPath: string, fileCount: number }`, binding exact file modes while excluding only generated `flows.json`, `gateway-personalization.json`, `node_modules/`, `release.json`, and `runtime-seal.json`.
- Produces: `verifySourceRelease(outputDir, { allowGenerated = false } = {}) -> { ok: true, manifest: object }`; throws on a missing, extra, or checksum-mismatched source file.
- Produces: `sealRuntimeRelease(outputDir) -> { sealPath: string, fileCount: number }`, recording every installed `node_modules` file after npm finishes.
- Produces: `verifyRuntimeRelease(outputDir) -> { ok: true, manifest: object, seal: object }`; requires a valid source manifest and runtime seal.
- Produces: CLI `node-red-release-cli.js verify-source|seal-runtime|verify-runtime <release-dir>` with one bounded JSON success line and nonzero failure.
- Produces: `writePortableBundle(sourceDir, outputPath) -> { bundlePath: string, fileCount: number, sha256: string }`, a gzip-compressed NDJSON stream containing regular files only.
- Produces: `extractPortableBundle(bundlePath, destination) -> Promise<{ directory: string, fileCount: number }>`; destination must not exist.
- Produces: extractor CLI `extract-node-red-release-bundle.js extract --bundle <path> --destination <absent-dir>` with one bounded JSON success line, nonzero failure, and partial-destination cleanup.
- Produces: `writeDeploymentControlManifest(artifactDir, commitSha, entries) -> { manifestPath: string, sha256: string }`.
- Produces: `verifyDeploymentControl(manifestPath, artifactDir, expectedCommitSha) -> { manifestSha256: string, files: object }`.
- Produces: control CLI `verify-deployment-control.js verify --manifest <path> --root <dir> --expected-commit <sha> --expected-manifest-sha256 <sha>` with bounded JSON success and nonzero failure.
- Produces: CLI `build-node-red-release.js --bundle <path> --source <dir> --round-trip-verify`, which writes and locally re-extracts the verified portable bundle without changing deployment wiring.

- [ ] **Step 1: Write inventory tests that fail before the builder exists**

Use a temporary output directory and the real canonical source tree. Assert that the release contains:

```text
flows.template.json
settings.js
package.json
package-lock.json
edge-channels.json
chirpstack-bootstrap.js
codecs/*.js
osi-*/package.json
the exact regular files declared by each osi-* package's package.json.files array
gui/**
release.json
```

Require `osi-device-writer/index.js`, `osi-db-helper/index.js`, `osi-lib/index.js`, both normalizers, and `gui/index.html` by exact path. Assert that the portable artifact has no `flows.json`, `gateway-personalization.json`, `runtime-seal.json`, `node_modules`, `*.test.js`, `.git`, credential file, SQLite file, source-map file, or undeclared package file.

Add secret-sentinel fixtures named `.env`, `.env.local`, `.npmrc`, `private.pem`, `id_rsa`, `farming.db`, `.hidden`, and `fixtures/nested.json`; none may enter the inventory even when placed below an `osi-*` package. Add a fixture runtime file that is not declared and require the builder to fail if the package entry point imports it, rather than silently shipping an incomplete helper. Add the inverse test: an unrelated undeclared file is ignored and cannot become manifest-approved merely because it exists.

Add GUI provenance negatives: pass a build directory from the caller worktree, a sibling checkout, a symlink escaping `repoRoot`, a stale preexisting `build`, and a detached worktree whose lockfile changes during install. Every case fails. In the positive case, remove `node_modules` and `build`, run the exact install/build commands through an injected command runner, and require the resulting `build` realpath plus `package-lock.json` to stay inside and unchanged under the same exact-commit worktree.

Add these negative controls:

```js
test('verifySourceRelease rejects a missing manifest entry', () => {
  const built = buildFixtureRelease();
  fs.rmSync(path.join(built, 'osi-device-writer/index.js'));
  assert.throws(() => verifySourceRelease(built), /missing release file/);
});

test('verifySourceRelease rejects a checksum mismatch', () => {
  const built = buildFixtureRelease();
  fs.appendFileSync(path.join(built, 'flows.template.json'), '\n');
  assert.throws(() => verifySourceRelease(built), /checksum mismatch/);
});
```

Also replace one source file with a symlink, add a FIFO/special-file fixture when the platform permits it, and require source verification to reject both. For the runtime seal, add one real lockfile-shaped local-package link such as `node_modules/osi-lib -> ../osi-lib`, one relative link contained entirely under `node_modules`, and one absolute or release-escaping link. Require links to the manifest-owned helper and internal dependency to pass and the escaping link to fail before activation.

- [ ] **Step 2: Run the builder test and capture the red signal**

```bash
node --test scripts/build-node-red-release.test.js
```

Expected: FAIL because `build-node-red-release.js` does not exist.

- [ ] **Step 3: Implement directory-derived inventory and checksums**

Use the canonical bcm2712 Node-RED directory as the package source, copy the canonical `flows.json` to the destination `flows.template.json`, use the feed-owned `settings.js`, and include `scripts/chirpstack-bootstrap.js`. Discover every `osi-*` directory. Classify `osi-db-integrity` as the one explicit service-owned exception: it is executed by the separate `osi-db-integrity` init service from its ROM path, is not a Node-RED package, and must be excluded by exact name with a test pinning both that service path and the absence of any second exception. Every other discovered directory is a package and must declare an exact, nonempty `package.json.files` array; a new package-less directory fails. Use only normalized regular-file paths; reject directory entries, glob syntax, hidden segments, duplicates, test/source-map extensions, secret-bearing basenames, databases, keys, and paths outside the package. Include `package.json` plus those exact declared files. Verify each relative CommonJS import from a declared runtime JavaScript file resolves to another declared runtime file or an allowed dependency, so a missing declaration fails the build.

Keep the Task 1 root inventory positive as well: exact flow/settings/package/lock/channel/bootstrap destinations; codecs referenced by the canonical channel/bootstrap inventory; and regular compiled GUI assets under the supplied build directory. Task 2 adds the resolver only after creating and testing it. Reject unknown root inputs instead of recursively accepting them. Adding a runtime file therefore requires changing a package declaration or a canonical root inventory source and updating its test.

The supplied GUI build directory is valid only when its realpath is exactly `<repoRoot>/web/react-gui/build`, `repoRoot` is the detached source root being packaged, and the build step for that invocation created it after removing any previous `build`. Do not accept the caller's ignored `web/react-gui/node_modules` or a caller-provided build output.

Put the manifest and verification primitives in `scripts/lib/node-red-release.js`; both the operator-side builder and the resident swap helper import that file. Write `release.json` last with this bounded shape:

```json
{
  "format": 1,
  "files": [
    { "path": "flows.template.json", "mode": 420, "sha256": "<64 lowercase hex>" }
  ]
}
```

Sort by destination path before writing. Modes are numeric and exactly 0644 or 0755 according to the reviewed executable inventory; a mode change is a manifest change. `verifySourceRelease` uses `lstat`, rejects unsupported format, unsafe paths containing `..` or an absolute prefix, duplicate paths, missing files, unlisted source files, checksum or mode mismatches, group/world-writable bits, symlinks, and non-regular special files. Its default portable-source mode rejects `flows.json`, `gateway-personalization.json`, `node_modules/`, and `runtime-seal.json`. With `allowGenerated: true`, it permits only those generated runtime paths while still rejecting any other unlisted file. It always rejects generated paths in `release.json`. Only the personalizer, runtime sealer, runtime verifier, and staged-release verifier after personalization use `allowGenerated: true`.

After personalization and npm installation on the Pi, `sealRuntimeRelease` writes `runtime-seal.json` with the release-manifest SHA256 plus sorted, type-specific entries for `flows.json`, `gateway-personalization.json`, and every directory, regular file, and symlink under `node_modules`. Regular-file and directory entries bind numeric mode plus SHA256 where applicable; symlink entries bind only type and link-target text because symlink permission bits are not portable semantics. Hash link text without following it. Reject any group/world-writable entry, absolute link target, broken target, or target whose normalized resolution escapes the release directory. A link leaving `node_modules` is valid only when its resolved target is a source-manifest-owned file or directory, which permits the current lockfile's `file:osi-*` package links without permitting arbitrary release traversal. Reject sockets, devices, FIFOs, and other special entries. `verifyRuntimeRelease` repeats those type, mode, and containment checks, checks the source manifest, personalization metadata, and runtime seal, rejects a missing, added, removed, changed, chmodded, or world-writable generated entry, and proves `gateway-personalization.json.sourceManifestSha256` equals the selected `release.json` hash. Add chmod-only mutations for source, generated, dependency, executable, directory, and symlink-target cases. Activation consumes `verifyRuntimeRelease`, never the source-only check.

- [ ] **Step 4: Make the builder write one safe transport bundle**

Do not use tar for the root-run extraction boundary. Write a gzip-compressed NDJSON bundle: the first line is an exact header with `format:1`, source-manifest SHA256, file count, and bounded uncompressed byte count; each following sorted line has only `path`, `mode`, `sha256`, and canonical base64 `content`. Source verification already forbids links and special files, so the bundle contains regular files only.

The extractor creates a new mode-0700 destination, accepts only normalized relative paths with no empty, dot, dot-dot, backslash, absolute, control-character, or duplicate segment, accepts only 0644/0755 modes, enforces per-file/entry/total bounds before allocation, decodes canonical base64, verifies each checksum while writing with exclusive creation, and verifies the final count, byte total, manifest hash, and `verifySourceRelease`. It creates every parent itself and never follows a bundle-provided link because links and type fields are not representable. Any parse, bound, write, or verification failure removes the entire staging directory before returning failure.

Add negative fixtures for `../`, absolute paths, backslashes, duplicate entries, unknown fields/type/link targets, symlink-chain and hardlink attempts, device/FIFO labels, unsafe modes, noncanonical base64, bad checksums, oversized content, truncated gzip, and a valid release followed by a bad final line. Prove no path outside the private destination changes and no partial destination remains.

For the extractor and deployment-control verifier, spawn the real CLI with the exact argv used by deploy. Assert one parseable bounded JSON success line, nonzero on every negative, no false zero exit from a module with no main, and extractor cleanup after a mid-stream failure. Direct function tests remain, but cannot substitute for these child-process contracts.

Add CLI tests proving a failed release build, bundle write, or round-trip extraction exits nonzero and removes only its own temporary/output path. Locally extract the produced bundle into a temporary directory and require byte-identical `release.json` plus a passing source verifier before reporting success. Task 1 does not modify `scripts/pipeline/deploy.py` or `deploy.sh`; the current GUI-tar deploy remains internally consistent until Tasks 2 and 3 replace producer and consumer atomically.

Extract the Train A target-manifest invariants into the generic deployment-control writer/verifier rather than creating a second independent manifest policy. Port every named Train A artifact test one-to-one, then add the sealed-release cases. Test the generic writer/verifier against a fixture artifact now: missing/tampered/extra control file, wrong commit, wrong bundle hash, wrong source-manifest hash, changed manifest bytes, symlink, unsafe path or mode, duplicate entries, and every former Train A negative must fail. Task 2 supplies the complete exact-commit file set after the personalizer and activation tools exist.

- [ ] **Step 5: Run and commit the release builder**

```bash
node --test scripts/build-node-red-release.test.js
node --test scripts/node-red-release-cli.test.js
node --test scripts/extract-node-red-release-bundle.test.js
node --test scripts/verify-deployment-control.test.js
node scripts/verify-profile-parity.js
git diff --check
```

```bash
git add scripts/lib/node-red-release.js scripts/node-red-release-cli.js \
  scripts/node-red-release-cli.test.js scripts/build-node-red-release.js \
  scripts/build-node-red-release.test.js scripts/extract-node-red-release-bundle.js \
  scripts/extract-node-red-release-bundle.test.js scripts/verify-deployment-control.js \
  scripts/verify-deployment-control.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-*/package.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-*/package.json
git commit -m "feat: build versioned Node-RED releases"
```

### Task 2: Activate and roll back the full behavior release on the merged identity lifecycle

Integrate release state, selector, mount, credentials, and recovery only after the Train A guard and repairs are green. Every lifecycle edit extends the exact merged four-role inventory and tests; it does not introduce a second restart owner or bypass the seven sentinel gates.

**Files:**

- Create: `scripts/personalize-node-red-release.js`
- Create: `scripts/personalize-node-red-release.test.js`
- Create: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red-runtime-config.sh`
- Create: `scripts/test-node-red-runtime-config-helper.sh`
- Modify: `scripts/build-node-red-release.js`
- Modify: `scripts/build-node-red-release.test.js`
- Modify: `scripts/verify-deployment-control.js`
- Modify: `scripts/verify-deployment-control.test.js`
- Modify: `scripts/pipeline/deploy.py`
- Modify: `scripts/pipeline/tests/test_deploy.py`
- Modify: `scripts/deploy-payload-swap.js`
- Modify: `scripts/deploy-payload-swap.test.js`
- Create: `scripts/node-red-release-mount.js`
- Create: `scripts/node-red-release-mount.test.js`
- Modify: `scripts/deploy-compatibility-set.js`
- Modify: `scripts/deploy-compatibility-set.test.js`
- Modify: `scripts/lib/deployment-state.js`
- Modify: `scripts/deployment-state-cli.js`
- Modify: `scripts/deployment-state-cli.test.js`
- Modify: `scripts/node-red-guarded-launch.js`
- Extend: `scripts/node-red-guarded-launch.test.js`
- Modify: `scripts/pi/run-staged-npm-ci.sh`
- Modify: `scripts/pi/run-staged-npm-ci.test.sh`
- Modify: `scripts/pi/backup-pre-deploy.sh`
- Extend: `scripts/pi/backup-pre-deploy.test.sh`
- Modify/Retain: `scripts/backup-chirpstack-sqlite.js`; preserve A0's wall-watchdog, schema-version, service-identity, and manifest contract
- Modify/Test: `scripts/backup-chirpstack-sqlite.test.js`; retain every A0 negative
- Modify: `scripts/pi/restore-pre-deploy.sh`
- Extend: `scripts/pi/restore-pre-deploy.test.sh`
- Modify/Retain: `scripts/audit-command-ack-state.js`, `scripts/audit-farming-database-state.js`, `scripts/seal-database-restore-baseline.js`, `scripts/database-integrity-recovery.js`, `scripts/reconcile-command-ack-state.js`, `scripts/sync-protocol-capability-cli.js`, `scripts/verify-command-activity-witness.js`, their direct tests, and selected-profile resident/ROM copies from the sync stop-loss slice
- Modify/Retain: both profiles' `files/usr/share/node-red/osi-sync-protocol-state/` and tests; preserve its shared parser, four-physical-root lock order, database-restore generation schemas, bounded activity checkpoint/head protocol, and witnessed-operation API
- Modify: `deploy.sh`
- Extend: `scripts/test-deploy-sh.sh`
- Modify: `scripts/test-deploy-atomic-payload-wiring.js`
- Modify: `scripts/migrate-cli.js`
- Modify: `scripts/migrate-cli.test.js`
- Create: `scripts/migration-payload-compatibility.test.js`
- Create: `scripts/fixtures/migration-payload-compatibility/index.json`
- Create: `scripts/fixtures/migration-payload-compatibility/*/`
- Create: `database/migrations/ordered/PAYLOAD_ROLLBACK.json`
- Modify: `scripts/verify-migrations.js`
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`
- Create: `scripts/flows-credentials-publish.js`
- Create: `scripts/flows-credentials-publish.test.js`
- Create: `scripts/test-guarded-init-services.sh`
- Extend: `scripts/test-ci-guard-wiring.js`
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-db-integrity`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-db-integrity`
- Modify/Verify: both profiles' `files/etc/init.d/osi-identityd`
- Modify/Verify: both profiles' `files/etc/uci-defaults/93_osi_deploy_guard_init` and `94_osi_identityd_enable`
- Verify/Preserve: both profiles' `files/etc/init.d/osi-deployment-inhibit`, `files/etc/rc.d/S01osi-deployment-inhibit`, and `files/usr/libexec/osi-deployment-inhibit.sh`
- Verify/Preserve: `scripts/test-deployment-inhibit.sh`
- Modify: `scripts/lib/factory-image-provenance.js` and `scripts/factory-image-provenance-cli.js` plus tests
- Modify: both profiles' `files/usr/libexec/osi-factory-image-provenance.js` and `osi-factory-image-provenance-cli.js`
- Regenerate/Verify: both profiles' `files/usr/share/osi-deploy/factory-image-provenance.json`
- Modify/Test: `scripts/generate-factory-image-provenance.js`, `scripts/verify-factory-image-provenance.js`, and `scripts/verify-built-factory-image-provenance.js`
- Modify: `docs/build/rpi5-full-osi-image.md` and `docs/build/building-firmware.md`
- Modify/Verify: both profiles' `files/usr/libexec/osi-identityd.sh`, `osi-gateway-identity.sh`, `osi-deployment-state.js`, `osi-deployment-state-cli.js`, and `osi-node-red-guarded-launch.js`
- Modify/Verify: both profiles' `files/usr/share/node-red/osi-db-integrity/` and `files/usr/share/osi-deploy/image-guard-manifest.json`
- Modify/Test: `scripts/verify-live-gateway-identity.js`
- Modify/Test: `scripts/verify-profile-parity.js`; add `files/etc/init.d/osi-db-integrity` and every new resident guard surface to `CANONICAL_PAYLOAD` with delete-one/drift cases
- Verify: `scripts/test-gateway-identity-helper.sh`, `scripts/test-osi-identityd.sh`, `scripts/test-identityd-service-lifecycle.sh`, `scripts/test-deploy-migration-wiring.js`, and `scripts/test-journal-bootstrap.js`
- Verify: `.github/workflows/field-journal.yml`
- Modify: `scripts/verify-communication-contract.js`
- Modify: `.github/workflows/migrations.yml`
- Delete after one-to-one test migration: `scripts/build-train-a-deployment-artifact.js`
- Delete after one-to-one test migration: `scripts/build-train-a-deployment-artifact.test.js`
- Delete after one-to-one test migration: `scripts/verify-train-a-deployment-artifact.js`
- Delete after one-to-one test migration: `scripts/verify-train-a-deployment-artifact.test.js`

Any Train B edit to `93`, guard-aware `94`, image-guard manifest, state/provenance CLI, inhibitor, or their source-to-profile map regenerates both profile provenance anchors through the documented `--write` commands, then runs `--check`, semantic/source parity, built-rootfs unit, profile-parity unit, and image-guard tests. The artifact builder binds the regenerated hashes; cached scope includes every changed source/resident/anchor/runbook file.

Make `osi-db-integrity` fail closed instead of granting it a specialized boot recovery lease. Its init first calls `startup-check --service osi-db-integrity --pre-diagnostic`; this variant verifies only persistent mount, guard/control hashes, inhibitor, deployment/recovery state, and request state. It deliberately skips farming-database open, quick-check, lineage, audit, and protocol predicates so corruption can reach the diagnostic. The helper then performs only an existence lstat plus read-only `PRAGMA quick_check` and returns `ok|recovery-required`; a missing main file on any completed/legacy gateway is recovery-required, not a fresh seed signal. It may not create an opportunistic `.bak-*`, prune backups, rename/quarantine the main file or sidecars, copy a prior backup, write `.integrity-recovery.json`, change permissions, or start/restart any role. On `recovery-required`, the init wrapper invokes only the resident deployment-state CLI's non-authorizing `record-database-recovery-required` verb. That verb O_EXCL-writes/fsyncs root-owned mode-0600 `/data/osi-deploy/database-recovery-required.json` as exact `{format:1,status:'recovery-required',requestId,databasePath:'/data/db/farming.db',observedDatabaseIdentitySha256,quickCheckResult:'missing'|'failed'|'timeout'|'unreadable',bootIdSha256,createdAt}`; the identity hash is the canonical missing-file observation when result is missing. It returns the same request on an exact retry and never creates a lease or mutation authority. Changed database/request facts, an unexplained existing record, or publication failure blocks. Every guarded role and S01 inhibitor treats an unresolved record as a hard startup block. The wrapper emits one bounded syslog fact and returns nonzero.

Recovery is deliberately separate from general readable-database restore. The ordinary controller acquires the persistent lease and enters `integrity-recovery-preparing -> integrity-recovery-invalidated -> integrity-database-quarantined -> integrity-database-restored -> integrity-reconciliation-required -> integrity-historical-dispositioning -> integrity-historical-clear|integrity-historical-blocked -> integrity-reconciled -> integrity-health-authorized -> integrity-finalizing`. Preparation uses only the artifact-owned integrity adapter/protocol verbs, exact explicit authority, same-operation lineage invalidation, and either valid current protocol roots or the journal-proven all-root legacy initializer; it appends integrity invalidation before preserving/moving SQLite bytes. Completion requires the exact recovered-row import graph or, only with an unchanged preexisting activity witness, the explicit backup-cutoff graph; it appends integrity reconciled but does not yet resolve/start. After stopped historical disposition is CLEAR, the controller writes the exact resolution, CASes to `integrity-health-authorized`, and issues the one-use integrity health permit while the latch remains. The guarded launcher is the only narrow latch exception: it starts the selected runtime once in read-only integrity-probe mode, proves zero sync/effect/scheduler/API/database mutations, stops it, and writes the health receipt. After the probe, recovery/topology receipts are fsynced and a nonterminal `integrity-finalizing` CAS retains lease/sub-operation. The finalize verb removes/fsyncs the exact latch, writes the removal receipt, and only then terminal `recovered` binds it and releases ownership; ordinary startup follows. Any failure keeps latch, inhibitor, and lease. Missing backup/root/authority, ambiguous command activity, or unreconciled evidence remains inhibited for forward/manual repair. Existing `.bak-*` files remain untrusted operator evidence and are never selected automatically.

Rewrite the helper tests around observable non-mutation. A corrupt main file with one or more valid `.bak-*` siblings must produce zero rename, copy, unlink, SQLite write, recovery stamp, chmod/chown, or service-start calls and leave every database byte/inode unchanged; the only allowed write is the exact deployment-state-CLI recovery request. Cover a missing database, healthy database, corrupt database, WAL/SHM/journal presence, legacy no-lineage state, malformed deployment state, stale marker, pre-diagnostic startup-check denial, proof that pre-diagnostic never opens/verifies farming DB or lineage, reboot/exact request retry, changed request/database identity, request publication crash, resolution receipt/CAS/removal crashes, injected quick-check timeout, and an attempted direct helper invocation. Missing/corrupt/unreadable each publish the matching latch and block S98/S99. The real init test must show the control-only guard precedes SQLite and that any non-`ok` result keeps all roles inhibited. Source guards reject reintroduction of `backupDb`, `pruneBackups`, quarantine/restore adapters, or a shell copy/rename path. Mirror the helper and init byte-for-byte, include both in profile/provenance controls, and run their direct tests in the required workflow.

**Interfaces:**

- Replaces: `stagePayload(root, stamp, srcFlowsPath)` with `stageSealedRelease(root, stamp, sealedSourceDir)`; it accepts only a complete `verify-runtime` source and cleans an incomplete absent-destination copy on failure.
- Produces: `personalizeRelease({ releaseDir, deviceEui, agroscopeHost, agroscopePort }) -> { flowsPath: string, metadataPath: string }` and CLI `personalize-node-red-release.js personalize --release-dir ... --device-eui ... --agroscope-host ... --agroscope-port ...` with bounded JSON success/nonzero failure.
- Produces: sourceable POSIX functions `resolve_chirpstack_value`, `resolve_gateway_identity_for_node_red`, and `resolve_node_red_personalization`; the last function sets only `RESOLVED_DEVICE_EUI`, `AGROSCOPE_RUNTIME_HOST`, and `AGROSCOPE_RUNTIME_PORT`.
- Produces: `activateRelease(root, stamp, expectedCurrentStamp, deploymentId) -> { previousStamp: string|null, activeStamp: string, generation: number }`.
- Produces: `rollbackRelease(root, expectedCurrentStamp, expectedPreviousStamp, deploymentId) -> { previousStamp: string, activeStamp: string, generation: number }` and refuses every inferred or quarantined candidate.
- Produces: `reconcileSelectionIntent(root, intentPath) -> { activeStamp: string|null, previousStamp: string|null, generation: number, reconciled: 'none'|'discarded'|'completed' }`; the exact pre-conversion result is `{ activeStamp:null, previousStamp:null, generation:0, reconciled:'none' }`, allowed only when current, selector state, and intent are all absent. It is the mandatory first operation on service startup and pipeline resume.
- Produces: `recoverFullReleaseConversion(root, generationDir, expectedGeneration, expectedGenerationSha256, expectedIdentity) -> { restored: true, deploymentId: string, activeStamp: string|null }`, which validates the immutable generation chain and exact compatibility snapshot, quiesces the exact merged four-role inventory, restores the pre-conversion topology under the early-boot inhibitor, verifies it, and records a recovery result generation only after success.
- Produces: `finalizeFullReleaseConversion(root, generationDir, expectedFinalGeneration, expectedFinalGenerationSha256, expectedMarkerSha256, expectedTopologySha256) -> { finalized: true, finalGenerationSha256: string, garbageDirectory: string }`, which first CAS-finalizes the parent with a null generation reference plus retained final hashes, then idempotently garbage-collects the now-unreferenced generation directory.
- Produces: `writeConversionCompleteMarker(root, markerPath, identity) -> { markerSha256: string }` and `verifyConversionCompleteMarker(root, markerPath, expectedIdentity) -> { activeStamp: string, topologySha256: string }`.
- Produces: `ensureStableLinks(root, guiPath) -> void`.
- Produces: `adoptLegacyRuntime(root, guiPath, baselineStamp, deploymentId) -> { activeStamp: string }`, creating and verifying the first rollbackable full-release baseline before stable links replace regular paths.
- Produces: resident CLI `node-red-release-mount.js ensure|verify|unmount-for-prune|unmount-for-recovery --release <absolute-release-dir>`, using an injected adapter in tests and real `mount --bind` plus `mount -o remount,bind,ro` on the gateway. `ensure` serializes concurrent init callers through a short-lived atomically acquired mount-operation lock; a losing caller waits only a bounded interval and then re-verifies the completed exact mount. It is idempotent only when `/proc/self/mountinfo` proves that exact directory is a self-bind mount with `ro`; a different source/target, `rw`, ambiguous escape, symlink component, stale lock without exact postcondition, or verification failure is fatal. `unmount-for-recovery` requires the held matching deployment/recovery lease, recorded conversion generation and mount identity, all four merged guarded roles absent under the inhibitor, and a recovery phase fsynced before unmount; the exact parent receipt becomes mandatory only after that receipt exists.
- Preserves: `currentStamp(root)`, `previousStamp(root)`, and `prunePayloads(root, keepN)` with full-release semantics backed by the durable selector record, not directory sort order.
- Produces: swap CLI mapping one-to-one to tested exports, printing one bounded JSON result, rejecting unknown/missing/duplicate flags, and exiting nonzero when the export rejects. Pin every live form:

```text
stage-sealed --root <root> --stamp <stamp> --source <sealed-dir>
activate --root <root> --stamp <stamp> --expected-current <stamp|none> --deployment-id <id>
rollback --root <root> --expected-current <stamp> --expected-previous <stamp> --deployment-id <id>
reconcile --root <root> --intent <absolute-path>
current --root <root>
previous --root <root>
adopt-legacy --root <root> --gui-path <path> --baseline-stamp <stamp> --deployment-id <id>
ensure-links --root <root> --gui-path <path>
prune --root <root> --keep <positive-integer>
recover-conversion --root <root> --generation-dir /data/osi-deploy/conversion/<id> --expected-generation <positive-integer> --expected-generation-sha256 <sha> --expected-deployment-id <id> --expected-target-commit <sha> --expected-compatibility-manifest-sha256 <sha>
finalize-conversion --root <root> --generation-dir /data/osi-deploy/conversion/<id> --expected-final-generation <positive-integer> --expected-final-generation-sha256 <sha> --expected-marker-sha256 <sha> --expected-topology-sha256 <sha>
mark-conversion-complete --root <root> --marker <absolute-path> --deployment-id <id> --target-commit <sha> --control-manifest-sha256 <sha> --compatibility-manifest-sha256 <sha> --source-manifest-sha256 <sha> --runtime-seal-sha256 <sha> --active-stamp <stamp>
verify-conversion-complete --root <root> --marker <absolute-path> --expected-target-commit <sha> --expected-control-manifest-sha256 <sha> --expected-active-stamp <stamp>
```

The resident startup/resume command is `node /usr/libexec/osi-deploy-payload-swap.js reconcile --root /srv/node-red --intent /data/osi-deploy/release-selection.json`.
- Produces: `DeploymentArtifact(root, bundle_path, control_manifest_path, commit_sha, manifest_sha256, deploy_sha256, verifier_sha256, profile_detector_sha256, profile_source_candidates)`; target-specific detected/expected profile and hardware-evidence hashes are added only after live detection and are never caller-selected defaults.
- Changes: `prepare_release_artifact(repo_root, expected_commit_sha) -> DeploymentArtifact`, built from an exact detached worktree.
- Extends: `DeploymentState` with migration class/pre-backup, SQLite-set restoration, selection intent, active generation, probe, and recovery facts while retaining Train A receipt compatibility.
- Produces: `pendingSetFingerprint(pending) -> sha256`, over canonical sorted ordered filename/checksum tuples; only an exact tested pending-set declaration can yield `payload-compatible`.

- [ ] **Step 1: Write deploy-time personalization tests**

Build a source-release fixture with the real broker node IDs and call `personalizeRelease`. Require:

- `deviceEui` is exactly 16 uppercase hexadecimal characters;
- host is a nonempty hostname or IP without whitespace, URL schemes, slashes, or control characters;
- port is an integer from 1 through 65535;
- `flows.template.json` is never changed;
- cloud broker `ec43625ea99685a6.clientid` becomes `device_<EUI>`;
- Agroscope broker `agroscope-mqtt-broker.broker` and `.port` receive the supplied non-secret values;
- `gateway-personalization.json` contains only `format`, `sourceManifestSha256`, `deviceEui`, `agroscopeHost`, and `agroscopePort`;
- identical input produces byte-identical `flows.json` and metadata; and
- rerunning against an existing generated file either produces the same bytes or fails before changing either file.

Add negative controls for an invalid EUI, URL-shaped host, invalid port, missing or duplicate broker node, source-manifest mismatch, an unknown metadata field, and inputs containing names such as `password`, `token`, `username`, or `secret`. The test must scan both generated files and prove fixture secret sentinel values are absent.

Spawn the personalizer CLI with the exact deploy argv for the positive and each parse/validation negative. Spawn every swap CLI verb used by deploy/recovery/startup against fixture roots; require state actually changes for `stage-sealed`/`activate`/`rollback`/`reconcile`, one bounded JSON line is emitted, and invalid or rejected operations exit nonzero. Calling a module that performs no command dispatch must fail the test.

Add a sourceable-shell test for the shared resolver. Use fake `uci`, `logger`, and gateway-identity functions plus a temporary `.chirpstack.env`. Require UCI to win per key, missing UCI to fall back per key, a disabled or unrecognized forwarding flag to produce `127.0.0.1:1883`, an enabled flag to use the resolved host and port, and an invalid or missing 16-hex gateway identity to fail before personalization. The personalization function must set only the three documented non-secret globals and must not read, print, or export Agroscope username/password, MQTT password, bearer token, or any fixture secret sentinel. Run the same cases under `/bin/sh` and mandatory BusyBox `ash`; absence of the BusyBox interpreter is a test/setup failure, not a skip.

- [ ] **Step 2: Replace flows-only swap tests with sealed release-unit tests**

Create fixture releases containing a portable `flows.template.json`, personalized `flows.json`, `gateway-personalization.json`, different markers in `settings.js`, `osi-device-writer/index.js`, `osi-db-helper/index.js`, `node_modules/osi-lib/index.js`, and `gui/index.html`. Seal each fixture. Require one activation to change every stable path to the same stamp:

```js
for (const runtimePath of [
  'flows.json', 'settings.js', 'package.json', 'package-lock.json',
  'node_modules', 'codecs', 'edge-channels.json', 'chirpstack-bootstrap.js',
  'osi-device-writer', 'osi-db-helper',
]) {
  assert.match(fs.realpathSync(path.join(root, runtimePath)), /payloads\/stampB\//);
}
assert.match(fs.realpathSync(guiPath), /payloads\/stampB\/gui$/);
```

Add negative tests for a missing `release.json`, missing personalization, a changed generated `flows.json`, a changed template, an unsealed dependency, `expectedCurrentStamp` mismatch, `expectedPreviousStamp` mismatch, no recorded predecessor, a quarantined predecessor, and pruning that attempts to remove the active target, recorded predecessor, journal participant, or quarantined diagnostic release. `listStamps` must use `lstat`, accept only strict stamp-syntax names that are real directories rather than symlinks, and exclude `current`, `activation-state.json`, flip temporaries, selection journals, and incomplete staging names. Add list/prune fixtures for each excluded entry and prove none is returned, traversed, or deleted. Prove the sequence A -> B -> failed B -> A -> C -> failed C -> A always chooses A, never B by directory order. Add child-process crashes after intent fsync, link rename, payload-directory fsync, active reread, selector-state fsync, and intent removal; resume each only through the real `reconcile` CLI and assert the exact old/intended state. Missing intent with selector/link disagreement, corrupt/unknown-field intent, a third link target, generation mismatch, or missing/tampered participant release must exit nonzero without changing either candidate. Add a legacy-adoption fixture where live files are regular files: adoption copies them into a validated baseline release before installing stable symlinks.

Exercise the read-only release mount through the real CLI with a fake mount adapter and parsed Linux mountinfo fixtures. After runtime sealing but before activation/start, `ensure` must establish a read-only self-bind mount and `verify` must recheck exact source, target, filesystem identity, and `ro`. Attempt writes and chmods to `flows.json`, `settings.js`, one helper, one dependency, and one GUI asset through the selected release and require `EROFS` with unchanged seal hashes. Simulate reboot by clearing the mount table; both init-service paths must run `ensure` again before consuming the selected release. Start both callers behind a barrier and prove exactly one performs the mount sequence while both return only after the same read-only postcondition. `unmount-for-prune` is allowed only while Node-RED and `osi-bootstrap` are verified stopped, the general deployment lease is held by the caller, and the target is neither active nor a recorded rollback/recovery participant; it unmounts that exact release before deletion and never remounts an existing release writable for deployment. `unmount-for-recovery` handles every release mount whose directory lies inside the compatibility snapshot being restored: journal the exact set, stop Node-RED, bootstrap, and database-integrity, fsync `recovery-unmounting`, unmount and verify absence one by one, then restore. After recovery, re-establish/verify a read-only mount only if the restored topology selects a sealed release; a restored legacy Train A topology has no release mount. Add crash before/after each unmount/remount plus wrong-source, wrong-target, `rw`, duplicate mount, stale/live mount-lock, timeout, `EBUSY`, unmount-failure, service-running, lease/receipt mismatch, incomplete mount-set, and prune-race negatives.

Set `disableEditor: true` in the shipped `settings.js` and add an executable Node-RED fixture proving the editor/admin flow-deploy endpoint cannot mutate the active flow. The read-only self-bind enforces the selected release bytes, but it does not make stable symlink directory entries under writable `/srv/node-red` immutable to root. `disableEditor` blocks the standard flow-deploy route, and the selector/topology verifier detects any replaced, removed, absolute, or out-of-release stable link and prevents restart. Add unlink and atomic rename-over-link negatives for every managed link; require the mounted release bytes and seals to remain unchanged, but do not claim the root runtime cannot replace a symlink. Mutable credentials, context, logs, and temporary state stay outside the sealed release under their existing `/srv/node-red` paths.

- [ ] **Step 3: Run the personalization and swap tests and capture the red signals**

```bash
node --test scripts/personalize-node-red-release.test.js
node --test scripts/node-red-release-mount.test.js
node --test scripts/deploy-payload-swap.test.js
```

Expected: FAIL because the personalizer does not exist and the current swap module stages and flips only `flows.json`.

- [ ] **Step 4: Implement a single `current` selector**

Use `/srv/node-red/payloads/current` as the only activation pointer and `/srv/node-red/payloads/activation-state.json` as the only predecessor authority. The bounded selector record is `{ "format": 1, "generation": <positive integer>, "activeStamp": "<stamp>", "predecessorStamp": "<stamp-or-null>", "quarantinedStamps": ["<sorted unique stamp>"] }`. Never infer a predecessor from directory names, mtimes, or “all stamps except current.” Activation requires the caller's exact expected current stamp and records that value as predecessor; rollback requires both the exact current and exact predecessor from the originating `DeployResult`.

Replace the current `fs.stat`-based stamp discovery. `listStamps` must call `lstat` on each direct child, require the strict release-stamp grammar, require a real directory, and reject symlinks even when they resolve to a directory. `current`, `activation-state.json`, `.flip-*`, selection journals, partial staging directories, and unknown names are control state, never release candidates. Pruning consumes only this filtered list and separately preserves every stamp named by selector or recovery state.

Make each selection crash-consistent. Fsync every regular file and directory in the sealed target tree before selection. Atomically write and fsync a root-owned mode-0600 `/data/osi-deploy/release-selection.json` intent containing the old selector record, intended new record, expected link target, deployment ID, and operation. Then create a temporary relative symlink and rename it over `current`, fsync the payloads directory, reread and verify the resolved active stamp, atomically write/fsync `activation-state.json`, and finally remove/fsync the intent journal.

Implement reconciliation as a first-class export and CLI command. With no intent, it requires `current` and `activation-state.json` to agree exactly; a missing selector record is accepted only before first conversion when `current` is also absent. With a valid intent and the old link/state, it discards the unstarted intent. With the intended link and either old or intended state, it verifies both releases and finishes the intended selector record. With the intended link/state and a leftover intent, it only clears the completed journal. A corrupt/unknown-field intent, missing intent while link/state disagree, third target, missing/tampered participant release, generation mismatch, or checksum mismatch exits nonzero without mutation. Use injected fsync/rename adapters and child-process termination after every persistence boundary to prove recovery; a mocked `rename` without durable reread is insufficient.

The selection primitive therefore has this shape:

```js
function flipCurrent(root, stamp, expectedCurrentStamp, deploymentId) {
  const target = payloadDir(root, stamp);
  verifyRuntimeRelease(target);
  fsyncReleaseTree(target);
  const prior = readAndVerifyActivationState(root, expectedCurrentStamp);
  const intended = nextActivationState(prior, stamp);
  writeSelectionIntent(root, prior, intended, deploymentId);
  const link = path.join(payloadsRoot(root), 'current');
  const tmp = `${link}.flip-${process.pid}-${Date.now()}`;
  fs.symlinkSync(stamp, tmp);
  fs.renameSync(tmp, link);
  fsyncDirectory(payloadsRoot(root));
  requireCurrentStamp(root, stamp);
  writeActivationStateAtomic(root, intended);
  clearSelectionIntent(root);
}
```

Stable runtime links point to `payloads/current/<path>`. `ensureStableLinks` must reject a managed path that is neither the expected symlink nor an explicitly adopted legacy path. On the first full-release deploy, `adoptLegacyRuntime` copies every existing managed regular file or directory plus the GUI into `payloads/<baselineStamp>`, copies the live flow to both `flows.template.json` and `flows.json`, records legacy personalization metadata without secrets, writes its source manifest, seals its existing `node_modules`, verifies it, activates the baseline, and only then replaces live paths with stable symlinks. The legacy metadata must mark `mode: "adopted"`; this is the only additional metadata key allowed for an adopted baseline. An interrupted conversion leaves the copied baseline and original live paths intact; the next run resumes from the verified baseline. Never move or link `flows_cred.json`, `.chirpstack.env`, or `/data/db`.

`stageSealedRelease` requires an absent destination and a source that already passes `verifyRuntimeRelease`, recursively copies it into `payloads/<stamp>`, reruns `verifyRuntimeRelease` on the copy, and removes the incomplete destination on any copy or verification failure. It does not personalize, install dependencies, or activate the release. Extend the builder to copy the feed-owned `node-red-runtime-config.sh` into the release root and require it in the source manifest. Legacy adoption copies that same candidate resolver into the baseline release because no versioned resolver exists in the legacy layout; the copied baseline is sealed before any stable link changes.

Install the swap helper as `/usr/libexec/osi-deploy-payload-swap.js`, the compatibility helper as `/usr/libexec/osi-deploy-compatibility-set.js`, the guarded Node-RED launcher as `/usr/libexec/osi-node-red-guarded-launch.js`, the credential publisher as `/usr/libexec/osi-flows-credentials-publish.js`, and the shared verifier/CLI as `/usr/libexec/node-red-release.js` and `/usr/libexec/node-red-release-cli.js`, outside the selected release, so verification and rollback remain available when the active release is broken. Pin each source path, installed path, root ownership, mode 0755, and manifest hash. The swap helper imports the resident compatibility helper for `recover-conversion`; it never duplicates snapshot/restore policy. Remove or tamper each resident dependency in tests and require startup/recovery to stop before service or topology mutation.

Rebase rather than delete Train A's compatibility-set guard. Preserve two identities: an immutable pre-mutation recovery snapshot containing the old application/runtime paths, all six links, and legacy-`94` forensic bytes; and a separate target-safety manifest containing inhibitor init/helper/S01 plus exact-present guard-aware `94` throughout every nonterminal phase. Journal `safety-installing` before the first safety mutation, install/fsync helper/init/`94`, activate S01 last, then append `safety-installed` with exact hashes; only that head authorizes application-link removal. A terminal tuple may retain present `94`, or bind absence only through its same-generation successful-consumption receipt. The restorable application inventory contains `/srv/node-red/`, GUI, four application inits, `93`, image-guard/provenance controls, integrity helper, bootstrap stamp, identity/state/launcher helpers, six rc links or absences, UCI evidence, guard/conversion markers, and every release/mount/credential/recovery resident. One source-to-profile-to-live map drives artifact, snapshot, marker, restore, parity, and delete-one tests. Finalization reverifies the copied recovery snapshot and requires each live entry to equal either its unmutated snapshot value or the exact journalled target; it verifies target safety separately and never restores or removes that set. The marker remains excluded from its own hash inputs. Inject failure after each safety-file rename/fsync/S01 activation and resident/link replacement; require exact application restoration under the inhibitor with the target safety hash unchanged.

Also make conversion recoverable across SIGKILL and power loss without a second lock authority. Use immutable generation-addressed records under `/data/osi-deploy/conversion/<deployment-id>/<generation>.json`, never one replaceable subordinate file. Each unknown-field-rejecting record is root-owned mode 0600, exclusively created and fsynced with its directory, and binds the deployment, target commit, retained artifact and live-backup identities, compatibility-manifest hash, exact pre-conversion topology including absent resident paths and marker state, baseline/intended stamps, phase, previous generation/hash, intended action, and bounded result. The parent state points to exactly one committed `{generation,sha256}`. For each external action, write a new immutable pre-action generation, fsync it, CAS the parent pointer to it, then act; afterward write a result generation and CAS the pointer again. An unreferenced proposal is discardable only because it never authorized action. Once the parent points to a pre-action generation, resume or recovery must consume that generation and cannot infer completion from live paths. Add crashes after proposal creation, parent-pointer CAS, external action, result-generation creation, and result-pointer CAS, plus external mutation and broken generation-chain negatives.

Before the first link replacement, CAS the ready guard marker to an installing generation, then install/verify the merged selected live-control paths plus every resident state/launch/credential/conversion/mount/compatibility/release verifier. The control artifact separately verifies all profile candidates and the source-to-live selection. CAS/fsync ready only after the complete live-control set matches. The armed state and marker mismatch inhibit startup. The snapshot pins prior files/absences, markers, managed paths, rc links, and recovery topology; retained recovery executes from its own copy.

Controller resume reads the parent state first and verifies the complete immutable generation chain. An incomplete conversion invokes `recover-conversion` before selector reconciliation or a new deploy. Recovery validates the persistent staging copy, full snapshot, generation chain, mount identities, and lock/lease owner; quiesces identityd first and proves procd plus lock absent, stops Node-RED, proves bootstrap/database-integrity one-shot children absent, and fsyncs the recovery phase; unmounts every selected release within the restore set; removes and fsyncs any conversion-complete marker; restores and verifies the exact pre-conversion application bytes, types, links, ownership, modes, and absent paths under the permanent early-boot inhibitor; requires exact-present guard-aware `94` until terminal CAS, never restores legacy bytes or removes a present valid guard-aware `94`; then writes the topology-activation receipt, recovery result generation, and parent advance. `unmount-for-recovery` authorization is phase-sensitive: before a deployment receipt exists, the matching active lease, conversion/recovery phase, generation chain, compatibility manifest, mount set, and lock owner are required; after receipt publication, the exact parent receipt is required as well. It never requires a receipt that cannot yet exist. Missing, corrupt, mismatched, orphaned, busy-mounted, or unrestorable state leaves all services stopped.

If `parentDeployment.conversionState.phase == 'complete'` while it references the final generation, resume enters finalize-only. It verifies generation/hash, marker, selector, mount, links, resident controls, and parent identities, then CAS-advances the nested state to `finalized` with `generationRef:null` while retaining final generation/marker/topology hashes and garbage-directory identity. Only then is deletion allowed. Crash during garbage collection resumes from nested `finalized` without the chain. Test proposal/pointer/action/result/marker/finalize CAS, partial deletion, fsync, and already-absent directory.

The conversion-complete marker lives only at `/data/osi-deploy/full-release-conversion-complete.json`. Its exact unknown-field-rejecting shape is `{ "format":1, "completedAt":"<UTC ISO-8601>", "deploymentId":"<id>", "targetCommitSha":"<40 lowercase hex>", "controlManifestSha256":"<64 lowercase hex>", "compatibilityManifestSha256":"<64 lowercase hex>", "sourceManifestSha256":"<64 lowercase hex>", "runtimeSealSha256":"<64 lowercase hex>", "activeStamp":"<stamp>", "activationGeneration":<positive integer>, "topologySha256":"<64 lowercase hex>" }`. `topologySha256` hashes managed stable paths plus activation state and exact hashes/modes for the merged selected live-control set, state pair, inhibitor, launcher, credential publisher, and recovery executables. Artifact provenance separately covers every profile-control candidate. No secret/credential path participates.

Write the marker mode 0600/root-owned with atomic rename and fsync. Verify final topology while the generation remains referenced, publish/reverify the marker, then CAS `conversionState` to `complete` with marker/final hashes. Only `finalize-conversion` clears the reference. `verifyConversionCompleteMarker` rereads current stamp/generation/manifests/mount/links, the merged selected live-control set, inhibitor, guarded launcher, credential publisher, resident recovery executables, and topology hash. The artifact separately binds every profile-control candidate. Any stale/forged/wrong-owner/path/hash/selector/mount/generation/topology fact forbids narrow mode.

Only a later deploy beginning with that live-verified marker may narrow the snapshot to the resident control plane: guard/conversion markers, the merged selected live-control paths and their exact rc links, permanent inhibitor, guarded launcher, credential publisher, swap/compatibility/mount/release/state executables, and every transitive recovery owner. Artifact verification still covers every profile-control candidate. Arm before any resident write; restore the prior live controls/marker around activation, and leave Node-RED stopped on failure.

After every later successful deploy, atomically rotate the marker to the new deployment/commit/control/source/runtime/stamp/generation/topology/mount facts before writing the deployment receipt. A rollback restores or rewrites the marker for the verified old release; the leased general journal blocks unsafe startup during the gap. Add crash tests before/after first marker write, general-state hash save, subordinate-journal removal, later marker rotation, rollback marker restoration, deployment receipt, and acceptance completion, plus corrupt/stale/wrong-commit/wrong-selector/wrong-mount/reused-marker negatives. Update the compatibility tests to prove the selected release owns all former `/srv/node-red` and GUI behavior paths before permitting narrow mode.

- [ ] **Step 5: Personalize, seal, classify migration compatibility, then activate**

Replace the per-file behavior fetches and `react_gui.tar.gz` path in `deploy.sh` with the staged, already verified deployment artifact. `prepare_release_artifact` builds only from a temporary detached worktree at `expected_commit_sha`; it rejects a non-full SHA, missing object, worktree HEAD mismatch, or any attempt to read deploy inputs from the caller's dirty tree, and removes the worktree in `finally`. Inside that worktree, remove `web/react-gui/node_modules` and `build`, run `npm ci --no-audit --no-fund`, require `package-lock.json` bytes unchanged, then run `npm run build`. Pass only that worktree's real `web/react-gui/build` to the release builder. A failed install/build, changed lock, stale output surviving cleanup, output outside the worktree, or read of caller-tree GUI bytes aborts before artifact publication or gateway contact.

Materialize a private artifact directory containing the bundle and exact-commit copies of `deploy.sh`, `scripts/verify-deployment-control.js`, `scripts/lib/node-red-release.js`, `scripts/node-red-release-cli.js`, the extractor, personalizer, swap helper, read-only release-mount helper, compatibility-set helper, deployment-state library/CLI, guarded launch wrapper, credential publisher, Train A's `scripts/detect-rpi-profile.sh`, `scripts/sync-protocol-capability-cli.js` plus its complete `osi-sync-protocol-state` dependency closure, `scripts/audit-command-ack-state.js`, `scripts/audit-farming-database-state.js`, `scripts/seal-database-restore-baseline.js`, `scripts/database-integrity-recovery.js`, `scripts/manifests/database-restore-reverse-adapters.json`, `scripts/manifests/database-recovery-implementations.json`, `scripts/manifests/database-integrity-source-trust-roots.json`, every manifest-enumerated `scripts/trust/database-integrity/*.ed25519.pub` public key, `scripts/reconcile-command-ack-state.js`, all five scripts' complete direct/transitive dependency closures, `scripts/backup-chirpstack-sqlite.js`, `scripts/pi/run-staged-npm-ci.sh`, `scripts/pi/backup-pre-deploy.sh`, `scripts/pi/restore-pre-deploy.sh`, every source and selected live entry from the exported merged control inventory, `scripts/migrate-cli.js`, its complete `lib/osi-migrate/**` direct/transitive dependency closure, repair/baseline scripts, ordered migration SQL, `CHECKSUMS.json`, `PAYLOAD_ROLLBACK.json`, the executable payload-compatibility fixtures, and every other file deploy, backup, migration, startup, or recovery opens, installs, or executes outside the release. Write `deployment-control.json` last with exact top-level keys `format`, `commitSha`, `sourceManifestSha256`, and sorted `files`; every file entry has only normalized relative `path`, lowercase SHA256, and mode 0644 or 0755. Include the bundle and exclude the manifest itself. Run both audit CLIs, baseline-seal, integrity-recovery, and reconciliation CLIs from an otherwise empty working directory, then delete each executable and dependency in turn; general or integrity restore must fail before preparation or SQLite mutation. `scripts/verify-command-activity-witness.js` is intentionally CI/build-only and is not installed live. Return the manifest SHA plus independently computed deploy/verifier/profile-detector hashes in `DeploymentArtifact`. Install the verified release library and CLI together as `/usr/libexec/node-red-release.js` and `/usr/libexec/node-red-release-cli.js`; install the state pair together as `/usr/libexec/osi-deployment-state.js` and `/usr/libexec/osi-deployment-state-cli.js`; install the mount helper as `/usr/libexec/osi-node-red-release-mount.js`, launcher as `/usr/libexec/osi-node-red-guarded-launch.js`, and credential publisher as `/usr/libexec/osi-flows-credentials-publish.js`. All relative-import and resident-hash contracts are tested, and delete-one/tamper controls for every resident helper block startup before any child process or credential write.

Once the generic artifact passes the full one-to-one Train A builder and verifier test mapping plus sealed-release tests, delete `build-train-a-deployment-artifact.js`, `verify-train-a-deployment-artifact.js`, and both tests in this same integration slice. Keep the compatibility-set snapshot/restore helper because it is still the live recovery primitive. The repository must not retain either a second artifact producer or an orphaned verifier authority.

Before durable staging, copy the deployment-state library/CLI, profile detector, role-stop/rc-quarantine coordinator, and compatibility helper into volatile root-owned mode-0700 bootstrap storage and verify independently held artifact hashes. Detect hardware, require `GatewayConfig.profile`, and derive the selected live-control mapping from the exported merged control manifest. Import A0's exact guard-bootstrap sequence without reordering: create intent; quiesce identityd, Node-RED, and both one-shots; reconcile volatile restart facts; snapshot application topology/legacy-`94` evidence; append `safety-installing`; install/fsync inhibitor/helper and exact-present guard-aware `94`; activate S01 last; append `safety-installed`; then remove the six application links in identityd, Node-RED, bootstrap, integrity order, install guarded controls, and publish ready. Nonterminal `94` is never removed. Only after marker, safety hash, absent-link, and stopped-role postconditions reverify may `claim-attempt` bind the ready generation. Only after the claim may the controller create `/data/osi-deploy/staging/<deployment-id>/artifact`, copy the complete artifact, and run staged code. Reverify the staged bootstrap closure against pre-claim copies and reproduce hardware/guard evidence. Volatile-bootstrap loss recopies the same closure; before claim it resumes the guard intent, and after claim it resumes only when no old-role start occurred. Unknown hardware/config, detector or mapping swap, guard mismatch, or stale topology creates no claim/staging. Require BusyBox-compatible `sha256sum`, validate manifest/deploy/verifier hashes against independently held values, and run the control verifier over every staged file. No pipe-to-shell, reverse tunnel, working-tree fetch, or unverified downloader remains. `deploy.sh` receives only the verified artifact directory, full commit, and manifest hash and reverifies before use:

```sh
ARTIFACT_DIR="${OSI_DEPLOY_ARTIFACT_DIR:?missing verified artifact directory}"
CONTROL_MANIFEST="$ARTIFACT_DIR/deployment-control.json"
CONTROL_VERIFY_JS="$ARTIFACT_DIR/verify-deployment-control.js"
RELEASE_CLI_JS="$ARTIFACT_DIR/node-red-release-cli.js"
EXTRACT_BUNDLE_JS="$ARTIFACT_DIR/extract-node-red-release-bundle.js"
PERSONALIZE_JS="$ARTIFACT_DIR/personalize-node-red-release.js"
SWAP_JS="$ARTIFACT_DIR/deploy-payload-swap.js"
RELEASE_MOUNT_JS="$ARTIFACT_DIR/node-red-release-mount.js"
RELEASE_BUNDLE="$ARTIFACT_DIR/node_red_release.ndjson.gz"
RELEASE_DIR="$PAYLOADS_ROOT/$DEPLOY_STAMP"
STAGED_RUNTIME="$TMP_DIR/node-red-runtime-release"
node "$CONTROL_VERIFY_JS" verify --manifest "$CONTROL_MANIFEST" \
  --root "$ARTIFACT_DIR" --expected-commit "$OSI_DEPLOY_COMMIT_SHA" \
  --expected-manifest-sha256 "$OSI_DEPLOY_CONTROL_MANIFEST_SHA256"
node "$EXTRACT_BUNDLE_JS" extract --bundle "$RELEASE_BUNDLE" \
  --destination "$STAGED_RUNTIME"
node "$RELEASE_CLI_JS" verify-source "$STAGED_RUNTIME"
. "$ARTIFACT_DIR/osi-gateway-identity.sh"
. "$STAGED_RUNTIME/node-red-runtime-config.sh"
resolve_node_red_personalization
node "$PERSONALIZE_JS" \
  personalize \
  --release-dir "$STAGED_RUNTIME" \
  --device-eui "$RESOLVED_DEVICE_EUI" \
  --agroscope-host "$AGROSCOPE_RUNTIME_HOST" \
  --agroscope-port "$AGROSCOPE_RUNTIME_PORT"
"$ARTIFACT_DIR/run-staged-npm-ci.sh" "$STAGED_RUNTIME"
node "$RELEASE_CLI_JS" seal-runtime "$STAGED_RUNTIME"
node "$RELEASE_CLI_JS" verify-runtime "$STAGED_RUNTIME"
# After snapshot validation, trap arming, and confirmed Node-RED stop:
node "$SWAP_JS" stage-sealed --root /srv/node-red \
  --stamp "$DEPLOY_STAMP" --source "$STAGED_RUNTIME"
node "$RELEASE_CLI_JS" verify-runtime "$RELEASE_DIR"
```

Source the resolver from the private staged release after source verification and source the manifest-owned gateway-identity helper directly from the verified control artifact; do not install either merely to compute personalization. Call `resolve_node_red_personalization` before the personalizer. Do not duplicate its UCI reads or `.chirpstack.env` parsing in `deploy.sh`. Pass only its three documented outputs to the personalizer; never pass usernames, passwords, MQTT passwords, or tokens.

The wrapper is the only command allowed to populate `node_modules`. It runs the lifecycle-bearing `npm ci` as the shipped `nobody:nogroup` identity (numeric UID/GID 65534, never UID 0) inside `/sbin/ujail`, with `HOME`, npm cache, temp, and all writable mounts limited to the unique staged runtime. It starts from an allowlisted environment containing only minimal PATH/locale, HOME/cache/temp, and npm registry settings; deployment, MQTT, ChirpStack, GitHub, cloud, and operator credentials are absent. Root-owned live paths, `/data`, `/srv/node-red`, `/usr/lib/node-red/gui`, `/etc`, `/data/osi-deploy`, the artifact, and sibling staging roots are absent or read-only. Root then lstat-walks, verifies, and chowns the result without following symlinks. A fixture dependency's lifecycle script attempts writes at every forbidden root and reads a parent secret-environment sentinel; every attempt must fail with sentinels absent and files unchanged. Missing/mismatched `ujail` or UID/GID, isolation feature, changed lock, escaping link, special file, ownership anomaly, or unexpected writable mount aborts before backup/migration/mutation. The private source is sealed and verified before any `/srv/node-red/payloads/<stamp>` path exists. After the compatibility trap is armed and Node-RED is confirmed stopped, copy the sealed runtime into the absent stamp and remove a partial copy on failure. Activation remains blocked until the copied runtime verifies.

Add missing/tampered/extra control-file, wrong-commit, wrong-manifest-hash, wrong-bundle-hash, changed-bytes-between-check-and-use, symlink, unsafe-mode, and dirty-caller-tree negatives. Run the artifact's migration report/apply fixtures from an otherwise empty working directory and delete each discovered library, script, SQL, manifest, and compatibility fixture in turn; every omission must fail before live mutation, proving no ambient Pi/ROM/repository migration asset is used. Capture the exact argv/env at the remote-execution boundary and prove no shell interpolation can turn a commit, deployment ID, path, or hash into another command.

Before applying migrations, load `PAYLOAD_ROLLBACK.json`. Its bounded shape has exactly `format`, `migrations`, and `compatiblePendingSets`. Each migration remains checksum-bound as `{ "sha256": "<canonical checksum>", "previousPayload": { "policy": "compatible|database-restore-required", "compatiblePreviousReleases": [{ "sourceManifestSha256": "<exact tested previous release hash>", "testCaseId": "<single-migration case>", "fixturePath": "scripts/fixtures/migration-payload-compatibility/<case>" }] } }`. A restore-required entry has an empty compatibility list. `compatiblePendingSets` is a sorted list of `{ "pendingSetSha256": "<hash of ordered filename/checksum tuples>", "previousSourceManifestSha256": "<exact previous release hash>", "orderedMigrations": [{ "filename": "NNNN__slug.sql", "sha256": "<canonical checksum>" }], "testCaseId": "<composed executable case>", "fixturePath": "scripts/fixtures/migration-payload-compatibility/<case>" }`. Unknown keys, duplicate identities, unsorted migrations, and a fingerprint that does not recompute exactly are invalid.

Require an exact entry for every ordered migration and exact checksum agreement with `CHECKSUMS.json`. Create `scripts/fixtures/migration-payload-compatibility/index.json` as the canonical sorted union of single-migration and composed-set case identities, and commit each referenced directory with the minimal previous source release, valid `release.json`, and pre-migration SQLite fixture. `verify-migrations.js` rejects missing, extra, stale-checksum, unknown-policy, untested hash or set, duplicate hash/case/path, traversal, missing fixture bytes, source-manifest mismatch, index drift, and orphan declarations, and invokes the compatibility registry so a name alone cannot pass. A single-migration case applies its named migration. A composed-set case starts from one fixture database, applies the exact actual ordered pending set using the real runner, verifies the final schema, then runs the exact previous release's shipped flow/helper read-and-write contract against that final database. It must expose interaction failures such as a later rebuild invalidating an earlier compatibility assumption. Run every case from an empty working directory with only manifest-owned inputs. Existing migrations and any undeclared composition may be classified conservatively as restore-required. Never infer set compatibility from risk strings or the conjunction of individually green cases.

Have `migrate-cli.js` emit one anchored line derived from the pending filenames and this manifest, never from the risk class alone:

```text
MIGRATION_ROLLBACK_CLASS=payload-compatible
MIGRATION_ROLLBACK_CLASS=database-restore-required
MIGRATION_ROLLBACK_CLASS=fresh-database
```

An empty pending set on an existing database is `payload-compatible` with no migration backup. For a nonempty set, resolve and verify the actual previous selected release, compute the ordered pending-set fingerprint from runner-owned filenames and checksums, and require one exact `compatiblePendingSets` entry for that fingerprint and previous source-manifest hash. Every member migration must also carry the checksum-matched compatible policy for that same previous hash, but those individual declarations are necessary only and never sufficient. Execute the composed case during verification. A skipped release, adopted legacy baseline, missing previous release, undeclared composition, changed order/checksum, or hash mismatch makes the whole set restore-required. Migration risk still controls mechanics and backup need, never payload compatibility.

Classify the pre-ledger path before mutation. For an existing database with a missing/empty ledger that requires `repair-sync-outbox-v2.js` or `baseline-existing-db.js`, force `database-restore-required`, stop writers, checkpoint, create and fsync the exact pre-repair byte-image backup, then run repair, baseline, and ordered migrations under that one recovery boundary. Do not repair or baseline before classification/backup. `fresh-database` is permitted only when this same leased invocation lstat-recorded `farming.db`, `farming.db-wal`, `farming.db-shm`, and `farming.db-journal` all absent before the first write; seeded `farming.db` from the deployment-control-owned seed; recorded the seed path/SHA256, deployment/control/source identity, and absence observation in the general journal before seeding; fsynced the new main file and parent; and then created the migration ledger without any intervening selector or identity change. Any preexisting main or sidecar, missing/corrupt proof, reused seed record, selector damage, or ownership mismatch is existing-state ambiguity and therefore `database-restore-required`, never fresh. A proven fresh database has no previous payload, emits no migration backup, and is not rollbackable to an older release. On a failed fresh-database activation, leave Node-RED stopped; remove only an unactivated attempted stamp and private temp data. If the attempted stamp was already selected, retain it for forensic consistency and never invent a predecessor or restore a general backup.

A successful restore-required run places its pre-mutation byte image under the fresh `OSI_DEPLOY_BACKUP_DIR/migrations/` and emits its absolute path, lowercase SHA256, byte size, and deployment ID before the first repair, baseline, or migration mutation. Allow `migrate-cli.js` to consume that verified precreated backup so it does not move the recovery boundary forward. The file must be root-owned mode 0600, lstat-regular with no symlink component, realpath-contained in the fresh backup directory, and pass SQLite integrity before mutation. `deploy.sh` forwards the class plus this identity. Reject duplicate, missing, mismatched, relative, escaping, stale, non-regular, wrong-owner/mode, or invalid backup facts before activation; require empty path/hash and size zero for the no-backup case.

Extend `scripts/migrate-cli.test.js` with synthetic ledgers, previous releases, and migrations for no-pending, proven same-invocation fresh seed, one exact-set compatible additive, two individually compatible migrations whose composed set is undeclared, a declared composed set with a later incompatible rebuild, different order/checksum, a different/older skipped payload hash, undeclared additive, declared restore-required trigger replacement, data, destructive, missing ledger, and empty ledger. Fresh negatives cover each preexisting sidecar independently, main-file presence, absence observation after first write, wrong seed hash/path/control identity, reused proof, missing parent fsync, ledger-before-proof, and selector generation drift; every case must classify restore-required or fail before mutation. Prove missing/empty-ledger repair and baseline take the backup before their first write and restore it on any later failure. Assert the structured return and captured log agree and that a doctored fingerprint/checksum, duplicate/unknown machine line, unexecuted composed case, or repair-before-backup ordering is rejected. Extend `verify-migrations.js` with remove-one for each set member, stale-checksum/fingerprint, unknown value, orphan test, untested hash/set, changed fixture, and index-drift controls. Do not reimplement either risk or payload-compatibility classification in shell.

Extend the Train A deployment journal rather than creating a release-only marker. Import its source/live inventory, nearest-covering persistent-mount proof, six-link topology, permanent inhibitor/guard-aware-94 safety inventory, two-boot factory seed/protocol-baseline authority, boot-epoch guard chain, and `protocol-initializing|protocol-dispositioning|protocol-ready|protocol-reconciliation-required` phases without redefining them. The factory completion tuple binds its seed receipt, factory-zero audit/source/disposition receipts, immutable capability/witness CLEAR anchors, command-activity genesis/head anchor, and both CLEAR states before the ready marker/final CAS; later negotiation or activity may only extend those anchors, never require a mutable terminal tuple. Missing roots, rewritten anchors, UNASSESSED historical state, or database-restore block cannot enter Train B. Before stop, intent binds immutable prior role states. Each preclaim reboot invalidates prior-boot stop/snapshot evidence: restore under the inhibitor when mutation occurred, append a higher epoch, then produce fresh stop/snapshot facts; claim binds only latest ready/revalidated epoch. The first `arm` creates state with `attemptSha256` and `leaseActive:true`; later Train B `arm` CAS-replaces an exact lease-free ordinary or factory `completed` parent plus acceptance receipt or `recovered` parent plus recovery/topology-activation receipts. Train B adds `backup-verified`, `migration-classified`, `pre-mutation-backup-verified`, `database-mutating`, `database-committed`, `database-baseline-sealed`, `sqlite-set-restoring`, the closed `integrity-*` phase family, `release-staged`, `selection-intent-fsynced`, `release-activated`, `runtime-probing`, `runtime-verified`, and `verification-in-flight`; terminal phases remain `completed|recovered`. State records profile, selected live-control mapping, guard epoch/generation, SQLite/migration/conversion/selector/candidate/stamp/control facts plus the protocol audit, purpose-specific pre-disposition backup, operation/argv/receipt, restore-preparation intent/result, sealed restore baseline/expected mutation report, integrity request/authority/forensic/reconciliation facts, capability head/witness, activity head/generation, and CLEAR identities. Every external mutation is bracketed by fsynced state; recovery/rehearsal/GC use one active sub-operation. Recovery pins the parent during actions, then one final CAS records terminal `recovered`, restored predecessor, recovery/topology receipts, clears the sub-operation, and releases the lease.

The imported factory terminal codec includes exact `factoryCapabilityAnchorSha256`, `factoryWitnessAnchorSha256`, and `factoryCommandActivityAnchorSha256` fields in both terminal receipts and the ready marker. The activity anchor is exactly the hash of canonical `{generation:0,entrySha256}`; mutable SQLite `activity_head` and external `head.json` bytes are never terminal anchors. Train B copies them byte-for-byte through arm, recovery, and terminal replacement and never substitutes current mutable heads.

Train B imports without reinterpretation `parentDeployment.databaseLineage`, `databaseLineageSha256`, the `database-lineage-invalidation` receipt kind/path/schema, and the monotonic `valid -> invalidating -> invalidated` transition from Train A/stop-loss. Its state/CLI tests mutate every field and reject factory-derived valid or invalidated state being reset to not-applicable by arm, recovery, migration, terminal completion, or parent replacement.

Train B imports both stop-loss database-recovery boundaries without reinterpreting them. A readable general recovery that would replace `farming.db` or any main/WAL/SHM/journal member uses one linked sub-operation with phases `database-restore-preparing -> database-restoring -> database-restore-auditing -> database-restore-proved-clean|database-restore-reconciling -> database-restore-reconciled`. Before mutation it requires the artifact-owned sealed restore baseline, whole-database audit, and `prepare-database-restore`. `NO_POST_BACKUP_DATABASE_DELTA` requires backup=baseline=current; `EXPECTED_DEPLOYMENT_MUTATION_ONLY` requires current=sealed post-mutation baseline and an exact manifest-owned backup-to-baseline delta. Both restore/re-audit to the backup. A post-baseline delta confined to the complete command inventory with reverse adapters may select `RECONCILIATION_REQUIRED`, append typed invalidation, snapshot, restore, merge into the backup schema, and complete the typed reconciled generation. Any post-baseline non-command/unknown delta, expected-mutation mismatch, unreadable current database, malformed evidence, or rejected preparation performs no general replacement. A latched missing/corrupt database never uses this classifier; it follows the separate explicit-authority integrity phases, preserves forensic bytes, appends integrity invalidation before restore, and remains stopped until import-or-cutoff reconciliation appends integrity reconciled. Recovery/topology receipts and terminal `recovered` CAS bind the selected branch and, for integrity recovery, the finalizing latch-removal receipt, baseline or integrity authority, restore epoch, audits, optional merge/forensic receipts, and final capability/activity heads.

Database-lineage invalidation and protocol invalidation solve different problems and both apply. A factory-derived valid main-file replacement completes `valid -> invalidating -> invalidated` and its immutable lineage receipt before either general or integrity preparation may authorize mutation. A legacy `not-applicable` database has no lineage transition, but still requires the applicable protocol preparation/invalidation. No caller treats a lineage receipt as command replay evidence or a protocol generation as filesystem provenance. Crash resume reverifies both authorities from the same recovery ID and exact available pre-mutation hashes; integrity recovery binds the unreadable/missing observation where a current database hash cannot exist.

Pin the transition table in the shared state library and test it from pure adapters before integration. Pre-arm work follows A0 boot-epoch and safety order. `arm` binds claim/seal/audit/backup/profile/guard identities; `armed -> backup-verified` revalidates them and copies `parentDeployment.databaseLineage` exactly, never changing a factory-derived valid/invalidated state to not-applicable. Sealed-release mode permits direct `backup-verified -> protocol-ready` for receipt-bound historical/database-restore CLEAR plus current-identity NEGOTIATED across all three chains or the exact factory-terminal tuple-bound CLEAR with intact capability/witness/activity anchors, matching valid `databaseLineageSha256`, a current decisive audit deriving `factoryDirectReadyEligible:true`, active identity null, and UNNEGOTIATED mode; unrelated local rows need not match seed bytes. Otherwise it requires `backup-verified -> protocol-initializing -> protocol-dispositioning -> protocol-ready|protocol-reconciliation-required`. The `commandLedgerPreDispositionBackup` is the only restore image for that mutation; general database evidence remains ineligible. Before restoring it, recovery enters its purpose-specific disposition-restore preparation phase and invokes the artifact-owned `prepare-disposition-restore` CLI, which delegates all chain/proposal validation and locking to `osi-sync-protocol-state` and emits an immutable four-way result. Shell consumes that result only: no CLEAR restores and retains the blocking state without invalidation; a valid unheaded CLEAR is completed by the helper from unchanged source facts before restore and then invalidated; committed CLEAR restores and then invalidates; `REJECTED` blocks before restore/start. Every readable general main-file replacement instead follows the separate lineage, sealed-baseline, and `prepare-database-restore` boundary; a latched missing/corrupt database follows only the integrity protocol. Reconciliation-required permits same-operation recovery and no role start. Forward migration begins only from protocol-ready: `migration-classified -> pre-mutation-backup-verified` when required, otherwise `database-mutating|release-staged`; then `database-mutating -> database-committed -> database-baseline-sealed -> release-staged -> selection-intent-fsynced -> release-activated -> runtime-probing -> runtime-verified -> verification-in-flight -> completed`. The baseline is sealed after the exact migration/repair runner receipt and before any start/probe. Startup rejects every protocol phase except ready and every capability state whose `databaseRestore.status` is not `CLEAR`; factory terminal or protocol-ready CLEAR+UNNEGOTIATED permits negotiation-only startup, and dispatch requires receipt-bound NEGOTIATED plus a valid activity chain. Recovery phases remain in the recovery sub-operation until final recovered CAS. Tests cover both deployment modes, direct-ready and factory-ready proof, first-install, all four purpose-restore results, all four general-restore results, every integrity result/authority branch, migration commit-to-baseline crashes, expected schema/ledger/backfill/new-table deltas, reconciliation merge/manual-block branches, already-completed resume, shell call/result removal, and every preparation/authority/snapshot/lineage/receipt/DB/generation/witness/head/restore/audit/merge/reconciliation boundary.

After terminal state reverify, `collect-staging` acquires the remote lock and CAS-reacquires a maintenance lease on exact `completed` plus deployment/acceptance receipts or exact `recovered` plus recovery/topology-activation receipts before installing one `staging-gc` active sub-operation. Its phases are `planned -> deleting -> complete|failed`; `retry-staging-gc` is the only `failed -> deleting` edge and reuses the same operation ID, candidate manifest, and protected-set hash. The protected set is the active terminal deployment, immediate predecessor, deployments named by unresolved recovery/reconciliation state, and every active operation. Delete only a non-symlink candidate outside that set with a cross-matching terminal tuple, fsync the parent, write the GC receipt, CAS its result, clear, release maintenance lease, then release lock. Crash resume uses the same ID. Factory-initializing state is ineligible. Never delete permanent receipts/claims, backups, capability chains/witnesses, releases, or the only recovery executable. Add terminal-kind, constrained-space, tamper, symlink, unresolved/history, and crash tests.

Conversion is an exact nested state machine, not an omitted parent phase: `conversionState.phase` is `none -> in-progress -> complete -> finalized` or `in-progress|complete -> recovering -> recovered|recovery-required`. `in-progress` requires a generation reference; `complete` retains the final reference plus marker/topology hashes; `complete -> finalized` atomically clears only that reference while retaining final hashes/garbage identity; garbage collection follows. Parent phase remains `release-staged` until nested conversion is `finalized`, then may advance to selector intent. Test the cross-product in library, deploy, startup, and resume; any parent advance with a non-final nested conversion fails. Remove `source-sealed` as a parent phase because seals are prerequisites to `arm`.

The gateway state retains A0's exact `{format:2,parentDeployment,activeSubOperation}` envelope, including factory-only `image-baseline-initializing`, boot epochs, and terminal `completed|recovered`. `activeSubOperation` is null or one recovery/rehearsal/GC record. Recovery actions pin the parent; after both topology-activation and recovery receipts verify, one CAS records the unknown-field-rejecting restored-predecessor union—`managed-terminal` with deployment/terminal-tuple hash or `legacy-compatibility` with compatibility/topology/database/flow facts—changes the parent to `recovered`, sets lease false, and clears. The recovered parent also has the closed discriminator `recoveryKind:'ordinary'|'database-integrity'`: ordinary forbids `latchRemovalReceiptSha256`; database-integrity requires the exact stop-loss latch-removal receipt hash plus matching request/operation/finalizing parent facts. Startup, status, post-terminal lease reacquisition, new-run `arm`, GC, and terminal tests reverify this branch. Rehearsal/GC retain receipt-then-parent-then-clear ordering. Post-terminal recovery reacquires a lease against the phase-discriminated receipt tuple. `status` returns both records/generations. Tests cover both predecessor branches, cross-kind fields, every action/result/receipt/terminal-CAS/clear boundary, and generic-operation rejection from factory-initializing state.

Extend the resident CLI with exact rehearsal, probe, acceptance, recovery, and GC forms while retaining A0's phase-discriminated receipt identity files. `verification-in-flight` binds deployment receipt; `completed` binds deployment plus acceptance; `recovered` binds recovery plus topology-activation and restored predecessor; the database-integrity discriminator additionally binds the latch-removal receipt, while every other branch forbids it. `complete` writes acceptance before terminal `completed`. Recovery from any supported phase persists one operation ID and finishes with the final `recovered` parent CAS. New-run `arm` and GC accept only exact terminal tuples. Missing, mixed, extra, or wrong-phase receipts, factory-initializing state, operation reuse, cross-kind resume, and release without exact terminal facts fail direct CLI tests.

`issue-probe-permit` creates one service-start capability for exactly one of `deployment-probe|recovery-health|integrity-recovery-health|rehearsal-old-probe|rehearsal-new-probe`. The permit binds operation/deployment/parent IDs, state phase/generation, service, exact candidate, database/control/compatibility hashes, gateway-lock owner, boot ID, nonce, expiry, and positive generation; its nonce is root-owned mode 0600 and never printed. The guarded launcher consumes state+nonce before child launch; pre-receipt death cannot respawn. General `recovery-health` is forbidden until `database-restore-proved-clean` or typed `DATABASE_RESTORE_RECONCILED`. `integrity-recovery-health` is the sole narrow exception to a still-present resolved integrity latch: it requires phase `integrity-health-authorized`, the exact stop-loss resolution/reconciled/historical-CLEAR/audit/activity/capability tuple, requires the stop-loss immutable integrity-health identity as input, stores its hash in the existing state permit, and forces read-only integrity-probe mode with every sync/effect/scheduler/API/database mutation surface disabled. It must stop and publish the exact health receipt before topology/recovery receipts or terminal CAS. A consumed attempt without PASS can advance only to the next positive permit generation after the stop-loss durable consumed state and retry proof establish prior process absence, unchanged audits/heads, and zero mutation/egress; otherwise it remains blocked. No other role, mode, respawn, permit purpose, missing latch, or phase can consume it. Test every legitimate purpose plus forbidden restore/integrity phase, latch mismatch, mutation attempt, crash before/after consume/start/health receipt/finalizing/latch unlink/removal receipt/terminal CAS, reboot, replay, procd mutation, and unsolicited start.

The Node-RED init-side check is a non-consuming preflight. In a pre-receipt phase it requires the same `--probe-nonce-file` locator and validates the unconsumed permit but cannot authorize the child; only the wrapper may pass `--consume-probe-permit`. If the existing procd instance respawns after receipt publication, the wrapper accepts its still-configured locator only when it is the recorded consumed path and the file remains absent, then authorizes from the reverified receipt/candidate. Any recreated file fails. A later controlled reload omits the locator. Pin this distinction in CLI and real init/wrapper tests so replacing the wrapper consume with an init consume fails.

Every merged guarded role verifies persistent `/data`, the root-owned ready guard marker, and role-specific `startup-check` before behavior. Node-RED alone may consume a one-use probe permit; identityd is the restart mutator, database-integrity is a read-only diagnostic one-shot, and bootstrap is a provisioning/restart-request one-shot, so none may consume it. Missing/tampered/shadowed facts block all roles. With state absent, only a verified abandoned claim/receipt set is allowed; marker absence never substitutes for factory state. A factory `completed` tuple is accepted only when the seed, factory-zero source/disposition receipts, immutable CLEAR anchors, complete current capability/witness/activity chains, `databaseRestore.status:'CLEAR'`, and ready marker cross-match. Current heads may equal the anchors, authorizing CLEAR+UNNEGOTIATED negotiation only, or be valid monotonic descendants; dispatch requires a descendant NEGOTIATED generation. Node-RED starts in `verification-in-flight` only with verified receipt/candidate/database hashes, or pre-receipt through the nonce wrapper. Volatile release mounts may be absent after reboot but never wrong/rw/ambiguous; establish/verify before consuming selected bytes. Recovery uses recorded artifact/backup/migration/conversion/selector/guard facts, never directory inference. The acceptance receipt or the ordered topology-activation plus recovery receipt pair precedes lease release; every unsafe state leaves Node-RED stopped. Real selected-control tests prove corrupt guard/root/helper, missing/partial/deleted factory protocol or activity state, rewritten anchor, invalid post-link descendant, nonzero factory audit, database-restore invalidation without reconciliation, direct invocation, reboot, profile drift, already-running one-shots, and identityd-ready-with-pending-restart perform zero unsafe opens or lifecycle mutation.

Keep Node-RED stopped continuously through resident-control installation, legacy adoption, migration, `current` activation, runtime verification, and the one final start. One outer deploy recovery coordinator owns compatibility restoration. Shell traps merely invoke it early; SIGKILL/reboot safety comes from the journal and startup inhibit. `run_schema_migration` and migration helpers return structured status to it; they must not replace the coordinator or call Node-RED `start`/`restart` on success. Add child-process/power-loss injection before and after repair/baseline, migration commit, every main/WAL/SHM/journal quarantine or rename, selector-intent write, activation, start, probe, marker rotation, receipt write, and lock release. Each restart must either produce the exact verified old or new set or remain stopped with checked recovery required.

The following is the single authoritative order for the controller, gateway deploy, and resume paths; later task prose may add checks but may not reorder these boundaries:

```text
acquire the stable local pipeline lock, then reconcile local state without replacing the lock inode
build and verify the exact-commit control artifact locally before gateway contact
acquire or reclaim only the matching remote lock, verify the durable covering mount and exact guard state, then classify state: exact ordinary/factory `completed` or `recovered` receipt tuples may enter generic deployment; an exact fresh-image reboot-required prefix may only halt/report or invoke the ROM-provenance-verified S01 baseline-completion handler, which must seed/reverify the provenance-bound DB, produce a zero-row audit/source receipt, initialize capability and command-activity genesis, record factory-zero CLEAR, bind all three logical anchors across all four physical roots plus the source receipt, and only then publish ready/final CAS; every generic action, malformed/incomplete factory prefix, absent or partial physical-root state after factory intent, and different ID is rejected even after reboot
copy the artifact-owned volatile bootstrap closure (state library/CLI, detector, role-stop/rc-quarantine coordinator, compatibility helper), verify independently held hashes, detect hardware, require GatewayConfig.profile, and derive the selected live-control mapping
publish/fsync the guard-bootstrap intent before a claim exists
execute the merged preflight: identityd stop plus procd/lock absence, Node-RED stop plus process absence, bounded bootstrap/integrity one-shot absence, then stable sentinel/request/completion reconciliation; snapshot/fsync the exported closed inventory and exact rc/default topology
append/fsync `safety-installing` with the target manifest, install/fsync permanent inhibitor/helper and exact-present guard-aware `94`, activate S01 last, append/fsync `safety-installed` with exact hashes, and retain legacy `94` only as forensic evidence; only then remove/fsync identityd S98/K98 links first, Node-RED S99/K99 next, bootstrap S99, and integrity S90
install/reverify the finalized guarded controls and selected live paths; publish the ready marker in preclaim-inhibit mode with all roles stopped and links absent
claim/fsync the one-use attempt binding the ready guard generation; after claim, any old-role process start abandons for a new ID, while controller restart/boot may resume only with all links absent and no old-role generation
copy the control artifact into that claim's staging root, reverify it, and extract/personalize/install/seal in private storage
run an advisory manifest-owned ACK audit; it cannot authorize arm or final backup
create the attempt-bound incomplete backup, reverify stopped roles/absent links and the previously captured topology, and keep all writers disabled
run the decisive manifest-owned ACK/outbox audit against the exact live database and verified command-activity chain; create its checked general SQLite backup plus the separate root-only integrity-checked/fsynced `commandLedgerPreDispositionBackup`, binding the exact audit row/domain hashes, activity generation/head, capability generation/head/witness, and guarded writer generation to both appropriate manifests; then run the staged ChirpStack helper against exact regular nonsymlink `/srv/chirpstack/chirpstack.sqlite`; it captures source device/inode, generated-config hash, `chirpstack` procd enabled/running/instance identity, and `PRAGMA schema_version`, executes SQLite online `.backup` with `.timeout 5000` plus a separate 30-second child watchdog, then requires unchanged source/service/schema identity, equal backup schema version, `PRAGMA quick_check = ok`, fsync, and hash; bind every fact and method into the manifest; WAL mutation must yield one consistent image while source replacement, concurrent DDL/schema change, stuck child, service restart, check, or fsync failure blocks publication without changing service state
arm the general deployment journal: exclusively create only the first deployment parent, otherwise CAS exact lease-free `completed` or `recovered` generation plus its phase-discriminated receipt tuple; bind attempt, profile, seal, stopped-state audit, and final-backup identities
CAS the armed parent to backup-verified with the same stopped-writer audit/backup proofs before any post-arm persistent mutation
if complete capability/witness/activity chains already prove receipt-bound CLEAR, `databaseRestore.status:'CLEAR'`, plus current-identity NEGOTIATED, or the exact factory terminal tuple plus intact anchors and matching valid `databaseLineageSha256` has a current decisive audit deriving `factoryDirectReadyEligible:true` with null active identity and UNNEGOTIATED mode, retain their hashes and CAS directly from backup-verified to `protocol-ready`; otherwise enter `protocol-initializing` before CLI use and run the journalled initialize -> disposition CLI -> source-receipt verification -> `record-v2-disposition` sequence; continue only from CLEAR and quarantine stops in reconciliation-required; pre-start disposition recovery enters its purpose-specific preparation phase and calls the shared-helper-backed `prepare-disposition-restore` CLI before shell touches the DB: `NO_CLEAR` consumes only `commandLedgerPreDispositionBackup`, restores/audits, binds preparation plus no-CLEAR recovery receipt, and leaves the polling block unchanged; `UNHEADED_CLEAR_COMPLETED` proves helper-owned receipt/witness/head completion before restore, then restores/audits and invalidates; `COMMITTED_CLEAR` restores/audits and invalidates; `REJECTED` fails before restore/start; shell never parses capability files and no branch overwrites, deletes, or downgrades any chain
restore only the reviewed guarded rc topology under startup inhibit and verify all guarded roles remain stopped
classify database provenance and pending-set rollback compatibility; create/fsync any required pre-mutation image
run repair/baseline/migrations under the recorded class and SQLite-set recovery boundary
adopt the legacy runtime under the parent-referenced immutable conversion generation chain if this is the first full-release deploy
copy the sealed runtime to the absent payload stamp, verify it, and establish/verify its read-only self-bind mount
write/fsync selector intent, activate payloads/current, reconcile selector state, and rotate the conversion-complete marker
issue the one-use deployment-probe permit, atomically consume it through startup-check, and start Node-RED once after read-only-mount verification
run local process, /gui, database, stamp, manifest, and mode probes
write/fsync the immutable deployment receipt and advance to verification-in-flight without releasing lease or locks
run controller verification, soak, and the linked selection-rehearsal operation; recover payload-only when the recorded class permits; before an exact predecessor database image is restored, complete applicable lineage invalidation, require the sealed post-mutation baseline, and call `prepare-database-restore`; accept backup-equal or exact expected-deployment-mutation-only restoration, or the snapshot merge plus typed `DATABASE_RESTORE_RECONCILED`, before live health, otherwise remain stopped in reconciliation-required
publish/fsync immutable evidence, write/fsync the acceptance receipt, advance to completed, then release the persistent lease, remote lock, and stable local lock
leave Node-RED stopped for fresh-database failures; require database restore for every undeclared/incompatible existing-state mutation; do not prune release candidates in this program
```

Print machine-readable lines for the pipeline:

```text
DEPLOY_ATTEMPTED_STAMP=<stamp>
DEPLOY_PREVIOUS_STAMP=<stamp-or-empty>
DEPLOY_ACTIVE_STAMP=<stamp>
DEPLOY_ID=<one-use-deployment-id>
DEPLOY_CONTROL_MANIFEST_SHA256=<64-lowercase-hex>
DEPLOY_COMPATIBILITY_MANIFEST_SHA256=<64-lowercase-hex>
DEPLOY_SOURCE_MANIFEST_SHA256=<64-lowercase-hex>
DEPLOY_RUNTIME_SEAL_SHA256=<64-lowercase-hex>
DEPLOY_MIGRATION_PENDING_SET_SHA256=<64-lowercase-hex-or-empty>
DEPLOY_MIGRATION_ROLLBACK_CLASS=<payload-compatible|database-restore-required|fresh-database>
DEPLOY_MIGRATION_PRE_BACKUP=<absolute-path-or-empty>
DEPLOY_MIGRATION_PRE_BACKUP_SHA256=<64-lowercase-hex-or-empty>
DEPLOY_MIGRATION_PRE_BACKUP_SIZE_BYTES=<positive-integer-or-0>
DEPLOY_ACTIVATION_GENERATION=<positive-integer>
DEPLOY_RECEIPT_SHA256=<64-lowercase-hex>
```

If the local probe fails after any restore-required mutation, including pre-ledger repair/baseline, `deploy.sh` must not select the previous payload against the changed database. Leave Node-RED stopped, keep the attempted stamp selected for forensic consistency, print the active stamp and restore-required class, and exit nonzero for controller recovery. If the class is `payload-compatible`, select and verify only the exact recorded predecessor, quarantine the failed attempted stamp, restart, rerun the bounded local probe, and report that active stamp. For `fresh-database`, apply the no-predecessor failure rule above. A failed rollback probe remains failure.

- [ ] **Step 6: Make init verify rather than mutate the selected release**

Keep `userDir=/srv/node-red` so credentials and mutable runtime state remain stable. Before reading `current`, run the resident selector reconciliation and fail closed:

```sh
node /usr/libexec/osi-deploy-payload-swap.js reconcile \
  --root /srv/node-red \
  --intent /data/osi-deploy/release-selection.json || {
    logger -t node-red.init "release selection reconciliation failed"
    return 1
}
```

Require the selected release after reconciliation and export its helper base:

```sh
local osi_release_dir
osi_release_dir="$(readlink -f /srv/node-red/payloads/current 2>/dev/null || echo "")"
[ -n "$osi_release_dir" ] && [ -f "$osi_release_dir/flows.json" ] || {
    logger -t node-red.init "active Node-RED release missing"
    return 1
}
```

Add `OSI_LIB_BASE="$osi_release_dir"` to `procd_set_param env`. Keep `flowFile: "flows.json"`; the stable `/srv/node-red/flows.json` symlink resolves through `current`. Keep `httpStatic` at `/usr/lib/node-red/gui`; that path becomes the stable GUI symlink. Replace the direct procd Node-RED command with `/usr/libexec/osi-node-red-guarded-launch.js`; pass the exact child argv after `--` and, only for an issued pre-receipt capability, the root-owned nonce path via `--probe-nonce-file`. The wrapper performs the service check on every procd launch or respawn. Source tests reject any direct Node-RED procd command, missing wrapper hash in the guard marker, mutable/relative nonce path, or respawn bypass.

Run the resident `verifyRuntimeRelease`, then `node /usr/libexec/osi-node-red-release-mount.js ensure --release "$osi_release_dir"`, then the mount helper's `verify` command before `procd_open_instance`; failure logs the selected stamp, sets no success status, and returns nonzero without starting Node-RED. Invoke only installed `/usr/libexec/osi-flows-credentials-publish.js` for `/srv/node-red/flows_cred.json`; init contains no second publication implementation. Remove `FLOW_FILE`, `DEVICE_EUI_VALUE`, Agroscope host/port inputs, flow parsing, broker-node lookup, `flowsChanged`, and every `writeFileSync` targeting a selected-release path. Credentials remain keyed by the existing broker node IDs and may use username/password values, but secrets never enter `flows.json` or release metadata.

Move credential publication into source `scripts/flows-credentials-publish.js`, install its artifact-verified bytes as root-owned mode-0755 `/usr/libexec/osi-flows-credentials-publish.js`, and call that exact path before Node-RED starts. It builds complete JSON in memory, validates expected broker-node IDs and value types, creates an exclusive same-directory temporary file without following links, applies the prior file owner/mode or the reviewed root-only defaults, writes all bytes, fsyncs, rereads and parses, atomically renames over `flows_cred.json`, fsyncs `/srv/node-red`, then rereads and revalidates the published bytes. A required broker credential cannot be reconciled as a warning: any source, validation, write, fsync, rename, ownership, or reread failure blocks startup while leaving the prior file intact whenever rename has not completed. Tests inject crashes and ENOSPC at every boundary, removed/tampered installed helper, corrupt or symlinked existing files, wrong owner/mode, malformed generated JSON, missing broker IDs, and secret sentinels; logs and machine output contain only bounded codes.

After the runtime release verifies, source `"$osi_release_dir/node-red-runtime-config.sh"`. Remove the inline `load_chirpstack_env_value`, `resolve_chirpstack_value`, identity-normalization, and Agroscope endpoint-selection implementations from `node-red.init`; call the versioned resolver functions instead. Startup may use `resolve_chirpstack_value` for profiles and credentials, but only deploy calls `resolve_node_red_personalization`. This gives deploy and init identical per-key UCI-first precedence without allowing startup to personalize or modify the selected release.

Configuration changes that affect device EUI or Agroscope host/port require a controlled redeploy or explicit re-personalization into a new stamp. Startup must not silently modify the active stamp.

For every merged guarded role, insert role-specific `startup-check` as its first behavioral action without moving, duplicating, or weakening identity/restart behavior. Node-RED ordering is exact: non-consuming startup/permit preflight, retained `gateway_identity_heal`, release-selection reconciliation, runtime verification, read-only mount establishment and verification, credential publication, then guarded-wrapper permit consumption and child launch. No mkdir, UCI/concentratord mutation, selected-release read/write, or credential write precedes the check. Node-RED alone can consume a probe permit. Identityd, bootstrap, and integrity perform their role-specific non-consuming checks before any daemon/one-shot behavior. Add real child-process negative controls for every merged sentinel and lifecycle branch. `payloads/current` requires verified runtime plus exact read-only mount, a failed root/marker/helper/verifier/mount check starts no behavior, and ROM fallback is allowed only for a proven pre-conversion state with no current/activation state.

- [ ] **Step 7: Strengthen the wiring guard**

Update `scripts/test-deploy-atomic-payload-wiring.js` to discover all runtime helper files using the same exported inventory function as Task 1. Require:

- no helper, codec, channel manifest, settings, package file, or GUI extraction writes directly to its live runtime path;
- source verification, personalization, `npm ci`, and runtime sealing occur before migration and activation;
- the compatibility trap is armed and Node-RED is confirmed stopped before the first resident/runtime/database mutation;
- the migration path preserves the outer recovery trap and contains no `start` or `restart` between the stop and verified `current` activation;
- injected failure after each resident install, legacy-link replacement, repair/baseline write, migration boundary, and activation restores the exact allowed topology and never starts Node-RED after a failed restore;
- deploy sources the resolver from the staged release, init sources it from the verified selected release, and neither contains a second implementation of UCI/env precedence or Agroscope endpoint selection;
- init, bootstrap, and controller resume execute resident selection reconciliation before reading or verifying `current`, and any reconciliation failure prevents Node-RED/bootstrap start;
- init and bootstrap establish and verify the exact selected release's read-only mount after runtime verification and before consuming any selected byte;
- `osi-bootstrap` selects the verified current release before its legacy ROM fallback and cannot execute an unsealed bootstrap when `current` exists;
- one `current` activation controls flows, helpers, dependencies, and GUI;
- init contains no write to `flows.json`, `payloads/current`, or any resolved selected-release path;
- procd launches only the guarded wrapper, every pre-receipt launch carries the exact nonce-file path, and no direct Node-RED command or respawn bypass is reachable;
- init invokes only the installed credential publisher, whose source/installed hashes are artifact-, marker-, snapshot-, and topology-owned;
- an explicitly compatible failed probe invokes `rollbackRelease` and verifies the resulting active stamp;
- an undeclared or restore-required failed probe does not select an older payload and emits the restore-required marker; and
- the negative self-test removes one inventory entry and proves the guard reports it.

Rebuild the required `.github/workflows/migrations.yml` release-boundary union from the merged workflow/tests plus `scripts/build-node-red-release.test.js`, `scripts/node-red-release-cli.test.js`, `scripts/extract-node-red-release-bundle.test.js`, `scripts/verify-deployment-control.test.js`, `scripts/personalize-node-red-release.test.js`, `scripts/test-node-red-runtime-config-helper.sh`, `scripts/deploy-payload-swap.test.js`, `scripts/node-red-release-mount.test.js`, `scripts/deploy-compatibility-set.test.js`, `scripts/migration-payload-compatibility.test.js`, `scripts/deployment-state-cli.test.js`, `scripts/node-red-guarded-launch.test.js`, `scripts/backup-chirpstack-sqlite.test.js`, profile detection, staged npm, backup/restore, credential publication, executable deploy/wiring, migration, communication, parity, and real finalized-role startup tests. Preserve every merged command and the A0-migrated absolute flow-size ceiling/reason; any owned change replaces only its exact measured final ceiling. `scripts/test-ci-guard-wiring.js` pins the exact rebuilt union with remove-one for the ChirpStack helper command/artifact entry and every other owner, extra-character, BusyBox, and merged-lifecycle ordering controls.

- [ ] **Step 8: Run the full-release activation checkpoint**

```bash
node --test scripts/build-node-red-release.test.js
node --test scripts/node-red-release-cli.test.js
node --test scripts/extract-node-red-release-bundle.test.js
node --test scripts/verify-deployment-control.test.js
node --test scripts/personalize-node-red-release.test.js
sh scripts/test-node-red-runtime-config-helper.sh
node --test scripts/deploy-payload-swap.test.js
node --test scripts/node-red-release-mount.test.js
node --test scripts/deploy-compatibility-set.test.js
node --test scripts/deployment-state-cli.test.js
node --test scripts/node-red-guarded-launch.test.js
sh scripts/pi/run-staged-npm-ci.test.sh
sh scripts/pi/backup-pre-deploy.test.sh
node --test scripts/backup-chirpstack-sqlite.test.js
sh scripts/pi/restore-pre-deploy.test.sh
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-integrity/index.test.js
node --test scripts/flows-credentials-publish.test.js
sh scripts/test-guarded-init-services.sh
busybox ash scripts/test-guarded-init-services.sh
sh scripts/detect-rpi-profile.test.sh
/bin/sh scripts/test-deploy-sh.sh --mode train-a-compat
busybox ash scripts/test-deploy-sh.sh --mode train-a-compat
/bin/sh scripts/test-deploy-sh.sh --mode sealed-release
busybox ash scripts/test-deploy-sh.sh --mode sealed-release
node --test scripts/test-deploy-atomic-payload-wiring.js
sh scripts/test-image-guard-bootstrap.sh
node --test scripts/generate-factory-image-provenance.test.js
node --test scripts/factory-image-provenance-cli.test.js
node scripts/generate-factory-image-provenance.js --check
node scripts/verify-factory-image-provenance.js
node --test scripts/verify-factory-image-provenance.test.js
node --test scripts/verify-built-factory-image-provenance.test.js
sh scripts/test-deployment-inhibit.sh
node --test scripts/verify-profile-parity.test.js
node --test scripts/verify-flows-size-ratchet.test.js
sh scripts/test-gateway-identity-helper.sh
sh scripts/test-osi-identityd.sh
sh scripts/test-identityd-service-lifecycle.sh
node scripts/verify-live-gateway-identity.js
node --test scripts/test-deploy-migration-wiring.js
node scripts/test-journal-bootstrap.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-communication-contract.js
cd web/react-gui && npm run typecheck && npm run build && npm run test:unit
cd ../..
node --test scripts/migrate-cli.test.js
node --test scripts/migration-payload-compatibility.test.js
node scripts/verify-migrations.js
python -m pytest scripts/pipeline/tests/test_deploy.py -q
sh -n deploy.sh
sh -n scripts/pi/backup-pre-deploy.sh
sh -n scripts/pi/restore-pre-deploy.sh
sh -n feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init
sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap
sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-db-integrity
sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-db-integrity
node scripts/verify-communication-contract.js
node scripts/verify-profile-parity.js
node scripts/verify-flows-size-ratchet.js
node scripts/test-ci-guard-wiring.js
node .claude/skills/anti-slop-writing/slop-check.js docs/build/rpi5-full-osi-image.md docs/build/building-firmware.md
```

Keep the current deploy/start path unchanged while reviewable dormant primitives land. Split this checkpoint into these green commits:

1. `feat: add sealed release activation primitives` contains the personalizer/resolver, control verifier, release builder extensions, swap/compatibility/state libraries and CLIs, sandbox wrapper, and their standalone tests. No stable path, init service, controller, or `deploy.sh` branch calls them yet.
2. `test: declare composed migration rollback policy` contains `PAYLOAD_ROLLBACK.json`, compatibility fixtures/registry, migration policy verifier/tests, and only backward-compatible runner APIs not invoked by the current deploy path. It proves exact composed pending sets and does not activate migration-aware selection.

Leave `deploy.sh`, init/bootstrap, pipeline deploy/controller/restore/config, stable-link conversion, and workflow wiring in the working diff until Task 3's controller-level negatives are green. Before each dormant commit, run its direct tests plus the existing deploy/migration gates to prove the current runtime path is unchanged. This preserves atomic runtime cutover without forcing roughly thirty independently reviewable files into one history unit.

Train A already owns the guarded launcher, restore shell test, and `test-deploy-sh.sh` train-a mode. Dormant Train B commits may extend their reusable helpers/tests only while all Train A cases remain green. The sealed-release `deploy.sh` cases, selected live-control wiring, and controller recovery/acceptance cases land together in the final cutover commit because they cannot pass against the old runtime path. File maps use `Modify/Extend`, never a second `Create` owner.

The execution report must carry a fixed cutover baseline: for each dormant commit, its SHA, the exact direct-test commands with exit codes, and the specific deploy/migration gate outputs proving the shipped runtime path was unchanged at that SHA. The final cutover review compares its diff and test union against that recorded baseline, not against a rerun reconstructed from memory.

### Task 3: Make controller routing, state, and recovery fail closed

**Files:**

- Modify: `scripts/pipeline/config.py`
- Modify: `scripts/pipeline/controller.py`
- Modify: `scripts/pipeline/deploy.py`
- Modify: `scripts/pipeline/restore.py`
- Create: `scripts/pipeline/github_evidence.py`
- Modify: `scripts/pipeline/evidence.py`
- Modify: `scripts/pipeline/bundles.json`
- Modify: `scripts/pipeline/tests/test_config.py`
- Modify: `scripts/pipeline/tests/test_controller.py`
- Modify: `scripts/pipeline/tests/test_deploy.py`
- Create: `scripts/pipeline/tests/test_github_evidence.py`
- Create: `scripts/pipeline/tests/test_evidence.py`
- Modify: `scripts/pi/backup-pre-deploy.sh`
- Extend: `scripts/pi/backup-pre-deploy.test.sh`
- Modify: `scripts/pi/restore-pre-deploy.sh`
- Extend: `scripts/pi/restore-pre-deploy.test.sh`
- Modify: `scripts/lib/deployment-state.js`
- Modify: `scripts/deployment-state-cli.js`
- Modify: `scripts/deployment-state-cli.test.js`
- Modify: `scripts/pi/run-staged-npm-ci.sh`
- Modify: `scripts/pi/run-staged-npm-ci.test.sh`
- Modify: `deploy.sh`
- Extend: `scripts/test-deploy-sh.sh`
- Create: `.github/workflows/pipeline.yml`

Execute real backup/restore/deploy scripts against explicit test-only roots and adapters. Source/runtime guards reject adapters when root is `/`, artifact mode is live, or the test sentinel is absent. Backup/restore tests cover checkpoint/topology/sidecars/fsync/no partial restart. Extend Train A's `scripts/test-deploy-sh.sh` with `--mode sealed-release`; after that extension, no-argument CI runs both modes. Positive cases end at the deploy-owned immutable deployment receipt and `verification-in-flight`; failure injection covers artifact/audit/claim/arm/backup/writer/migration/conversion/release/mount/selector/permit/start/probe/receipt and deploy-owned recovery. Acceptance/evidence failures belong only to real controller tests. Run both modes under `/bin/sh` and BusyBox `ash`; require exact phase, one recovery dispatch, no unsafe restart/success output, and bounded logs.

**Interfaces:**

- Produces: `ResolvedBundleContext(repo_root: Path|None, execution_kind: str, target_name: str|None, target: object|None)`.
- Changes: `GatewayConfig.profile: Literal['bcm2712','bcm2709']` is required for every controller-owned gateway deployment; it is compared with live detector output and never selects a profile.
- Produces: `resolve_bundle_context(bundle, gateways, servers, repo_roots) -> ResolvedBundleContext`.
- Produces: `require_authorized_gateway(context, authorized_gateway_targets) -> None`, called before git, artifact build, backup, deploy, or SSH; the default authorization set is empty.
- Produces: `BackupResult(ok, live_backup_dir, database_backup_path, command_ledger_pre_disposition_backup_path, command_ledger_pre_disposition_backup_sha256, deployment_id, target_commit_sha, control_manifest_sha256, compatibility_manifest_sha256, baselines, detail)`; the purpose-specific path is never interchangeable with the general or migration backup.
- Changes: `pre_deploy_backup(gateway, artifact, timestamp, deployment_id) -> BackupResult` and `deploy_to_gateway(gateway, artifact, backup) -> DeployResult`.
- Produces: a closed `RestoredPredecessorIdentity` union: `{kind:'managed-terminal',deploymentId,terminalTupleSha256}` or `{kind:'legacy-compatibility',compatibilityManifestSha256,topologySha256,databaseIdentitySha256,flowStamp}`. No discriminator permits fields from the other branch.
- Produces: `RecoveryResult(operation_id, recovery_receipt_sha256, topology_activation_receipt_sha256, recovery_kind, integrity_latch_removal_receipt_sha256, restored_predecessor, restored_predecessor_sha256, recovered_generation, durable_completed, payload_ok, database_required, database_ok, database_restore_protocol_ok, database_restore_branch, database_restore_epoch, database_restore_preparation_sha256, database_restore_merge_receipt_sha256, command_activity_head_sha256, capability_head_sha256, health_ok, active_stamp, detail)` with `ok` true only when every required leg and the full discriminated recovered terminal tuple reverify. Direct unit tests reject null/unknown recovery kind, ordinary-plus-latch receipt, and database-integrity-without-latch receipt.
- Produces: `recover_gateway(gateway, deployment, backup, restore_database, recovery_operation_id) -> RecoveryResult`; the operation ID is fsynced locally before first remote contact and the general pre-deploy database copy is never an automatic restore candidate.
- Produces: pipeline states `awaiting_external` and `rollback_failed` in addition to existing states.
- Produces: `PipelineState.external_expected: dict[str, ExternalExpectedRecord]`, persisted when entering `awaiting_external` with exact repository SHAs, execution kind, target/environment, and required checks.
- Produces: `PipelineState.external_evidence: dict[str, ExternalEvidenceRecord]`, retaining authoritative provider response digests plus validated repository SHAs, target, named checks, immutable run/deployment IDs, and completion time.
- Produces: `PipelineState.in_flight: InFlightDeployment|None`, recording bundle, target, phase, deployment ID, artifact/control hashes, backup identities, attempted/previous stamps, verification boundary, and soak start.
- Produces: explicit versioned `PipelineState.to_dict()/from_dict()` and atomic `save_state()`; nested security records are never shallow plain dictionaries.
- Produces: `GitHubEvidenceClient`, an injected timeout-bounded provider interface whose implementation performs two consistent authoritative reads and returns normalized run/deployment evidence only.
- Produces: `SelectionRehearsalResult` and `rehearse_release_selection(...)` in `restore.py`; Task 7 invokes this already-tested controller phase and does not invent live-only orchestration.
- Produces: `write_evidence_bundle(identity, checks, root) -> EvidenceBundleResult(manifest_path, manifest_sha256)`, publishing a secret-scanned immutable directory only after every evidence file is written and hashed.

- [ ] **Step 1: Add controller-level failing tests**

Patch controller collaborators and call `run_pipeline`; do not limit these tests to `_first_failure` or dataclass properties. Cover:

For `test_gateway_bundle_resolves_its_configured_target_not_kaba100`, call the pure resolver with only a `silvan` bundle and assert the returned context contains `gateways["silvan"]`; do not run the mutation pipeline. Then call `run_pipeline` with that configured target and the program's authorization set `{ "kaba100" }`; require an unauthorized-target error and zero git, artifact, backup, deploy, or SSH calls. For `test_server_bundle_never_calls_gateway_backup_or_deploy`, use B7 and assert every gateway mock has zero calls while state becomes `awaiting_external`.

For the remaining cases, assert these exact outcomes:

- every real controller-owned gateway config has an allowed `profile`, Kaba100 is `bcm2712`, and absent/unknown values fail during config load before git or network activity;
- controller/deploy tests prove volatile detector execution and claim publication precede durable staging, and unknown/conflicting hardware, detector hash swap, mapping swap, or staged-detector mismatch creates no staging directory;
- loss of the volatile bootstrap after claim recopies the same trio and resumes the same claim/deployment ID; it never creates a second claim; and

- an unknown repository or target leaves git, backup, deploy, and SSH mocks untouched;
- failed recovery persists `rollback_failed`, sends an urgent alert containing `rollback failed`, and never emits `restored`;
- successful payload-only recovery runs the bounded health function before persisting `halted`; database recovery may run live health only after exact no-activity proof or typed database-restore reconciliation;
- an explicit-compatible probe failure selects and verifies the previous payload without restoring the DB;
- a restore-required probe failure with `auto_restore_database=false` persists `rollback_failed` without selecting the previous payload;
- a restore-required probe failure on Kaba100 first stops all writers, completes applicable database-lineage invalidation, seals or reverifies the post-migration baseline from the exact runner receipt, runs both audits, and calls `prepare-database-restore`; backup-equal or exact expected-deployment-mutation-only proof restores/re-audits before selecting the predecessor, a command-inventory-only post-baseline delta follows invalidation/merge/reconciliation before selection, and any expected-mutation mismatch, post-baseline non-command/unknown delta, or unreadable current database performs no general restore or selection;
- a missing, invalid, or failed migration-backup restore remains `rollback_failed` with Node-RED stopped;
- a missing/advanced command-activity witness, changed delivered ACK with unchanged counts, changed domain postcondition, unreadable current DB, incomplete merge, unsafe external effect, or missing reconciled generation remains `rollback_failed` with Node-RED stopped and the recovery lease retained;
- a fresh-database probe failure never calls database restore or payload rollback, never invents a previous stamp, and leaves Node-RED stopped;
- a completed bundle persists `current_bundle_idx == 1`;
- resume from index 1 never calls collaborators for bundle 0; and
- a backup or deploy exception is caught, alerts once, and leaves state `halted`.

For both ordinary halt and rollback failure, make the alert collaborator throw. Require the controller to atomically persist `halted` or `rollback_failed` before the alert call, retain that terminal state, record one bounded `last_alert_error` in a second atomic save, and never resume, advance, or overwrite the original failure detail because notification failed.

Add versioned state round-trip tests for `ExternalExpectedRecord`, `ExternalEvidenceRecord`, and `InFlightDeployment`. Reject unknown/missing fields, short or uppercase hashes, invalid checks/status/timestamps/phase, a plain dict where a typed record is required, cross-record bundle/target/SHA mismatch, and a cursor inconsistent with `in_flight`. Invalid persisted state halts for operator recovery; it never resets, recomputes expected SHAs, advances, or starts a collaborator.

Add crash-injection controller tests after artifact creation, backup completion, immediately before remote deploy, after remote deploy returns but before local state save, after activation, during verification, mid-soak, and every rehearsal transition. Persist an in-flight phase before and after each external mutation. On resume, first run `node /usr/libexec/osi-deployment-state-cli.js status --state /data/osi-deploy/deployment-state.json --receipts /data/osi-deploy/receipts --deployment-id <recorded-id>` and require its exact operation kind, phase, lease, parent identity, and immutable receipt facts. If conversion is incomplete, invoke `recover-conversion` before the exact resident `reconcile --root /srv/node-red --intent /data/osi-deploy/release-selection.json` command. Cross-check target commit, deployment/control/compatibility/source/runtime hashes, backup identity, migration class, selector stamps/generation, mount identity, and result before deciding the next phase. A verified deployment receipt permits only the remaining verification/soak/linked-rehearsal/evidence phases while the parent lease stays active. If general state reports an incomplete `selection-rehearsal` sub-operation, resume `rehearse_release_selection` from its exact old/new/last-good facts and immutable prior transition receipt before requiring the active stamp to equal the deployment receipt. Outside that bounded case, a matching unsafe nonterminal deployment record invokes checked recovery, while missing, reused, corrupt, ambiguous, previous, unexpected, or unverifiable state halts with Node-RED stopped. It never reruns deploy by default and never relies on an undefined prose marker or separate rehearsal authority.

Take an exclusive OS-level lock on a stable sibling such as `<state-dir>/pipeline-state.lock` before the first state load and hold that unchanged inode through every atomic JSON replacement and external call. Never lock the replaceable state-file inode itself. A second local controller, resume, reset, dry run, or external-verification invocation fails before reading a mutable snapshot or calling collaborators. On the gateway, acquire the resident root-owned deployment lock before backup; bind its metadata to operation/deployment IDs, PID, boot ID, target commit, and controller state generation. A stale same-ID owner is reclaimable only through explicit journal reconciliation or a linked recovery/rehearsal operation; a different deployment ID never steals it, including after reboot removes `/var/lock`, because the persistent lease remains authoritative. Test two simultaneous local processes across repeated `save_state` replacements, two simultaneous remote contenders, stale same-boot PID, reboot with lost volatile lock plus different ID, linked recovery/rehearsal reclaim, mismatched parent, and receipt reuse; exactly one authorized operation may enter the first mutation.

At the controller boundary, add negative tests in which `BackupResult` has a missing live directory, database path, deployment ID, target SHA, control-manifest hash, compatibility-manifest hash, mismatched artifact SHA, reused deployment ID, or unsafe path/value. Each must stop before the deploy SSH collaborator is called. Capture the successful remote argv/env and prove every `OSI_DEPLOY_*` compatibility value plus control/compatibility-manifest hashes and artifact directory are shell-quoted single values and match the parsed backup/artifact objects exactly.

Load the real config in a parameterized test and require every bundle to resolve. B6 and B9 must resolve as `external_ci` with no gateway or server target, B7 as an external server target named `test`, and every remaining controller-owned bundle as an OSI OS context. For all three non-edge bundles, assert no gateway, git-mutation, backup, deploy, or SSH collaborator is called.

- [ ] **Step 2: Run the focused tests and capture the red signal**

```bash
python -m pytest scripts/pipeline/tests/test_config.py \
  scripts/pipeline/tests/test_controller.py scripts/pipeline/tests/test_deploy.py -q
```

Expected: FAIL because the controller hardcodes Kaba100, ignores `servers` and `repo`, does not advance the cursor, and ignores restore failure.

- [ ] **Step 3: Validate repository and target before mutation**

Add `execution_owner: str = "controller"` to `BundleConfig`. The only accepted values are `controller` and `external`. Resolve repositories from explicit roots supplied to `run_pipeline`; default osi-os to the current repo and osi-server to `OSI_SERVER_REPO_ROOT` or the existing sister directory.

Keep target resolution separate from authorization. `run_pipeline` accepts an explicit `authorized_gateway_targets` set that defaults to empty; its CLI requires a repeated `--authorize-gateway <name>` for a controller-owned deployment. Resolve first, then require the resolved target name to be in that invocation-scoped set before git, artifact construction, backup, deploy, or SSH. This program passes only `kaba100`. A configured gateway, `auto_restore_database`, or a loaded key never grants authority. Reject unknown/duplicate authorization names and test configured-but-unauthorized Kaba100 and non-Kaba targets with zero collaborators called.

```python
def resolve_bundle_context(bundle, gateways, servers, repo_roots):
    if bundle.execution_owner == "external":
        allowed_repositories = {"osi-os", "osi-server"}
        required = set(bundle.external_required_repositories)
        if not required or not required <= allowed_repositories:
            raise ConfigError("invalid external repository declaration")
        if bundle.ci_only:
            if bundle.deploy_target:
                raise ConfigError("external CI bundle cannot have a deploy target")
            return ResolvedBundleContext(None, "external_ci", None, None)
        if not bundle.deploy_target or bundle.deploy_target not in servers:
            raise ConfigError(f"unknown external server target: {bundle.deploy_target}")
        return ResolvedBundleContext(None, "external_server", bundle.deploy_target,
                                     servers[bundle.deploy_target])
    if bundle.repo not in repo_roots:
        raise ConfigError(f"unknown repository: {bundle.repo}")
    if bundle.repo != "osi-os":
        raise ConfigError(f"controller execution unsupported for repository: {bundle.repo}")
    if bundle.needs_deploy and bundle.deploy_target not in gateways:
        raise ConfigError(f"unknown gateway target: {bundle.deploy_target}")
    return ResolvedBundleContext(repo_roots["osi-os"], "gateway",
                                 bundle.deploy_target,
                                 gateways.get(bundle.deploy_target))
```

Mark B6, B7, and B9 as `execution_owner: "external"`. Keep B6 and B9 targetless CI bundles; change B7's target to the existing server key `test`. Do not invent an automated server deployment path in this plan. The controller sets `awaiting_external`, records the bundle ID, alerts with the applicable CI or test-server runbook path, and exits before git mutation or network access.

Add `external_required_checks` and `external_required_repositories` to the three external bundle definitions. Before entering `awaiting_external`, resolve the exact edge/server SHAs from the current integration state and persist them in `ExternalExpectedRecord`; resume never recomputes or silently advances those pins.

Add `--verify-external-run <bundle-id>=<github-run-id>` for B6/B9 and `--verify-external-deployment <bundle-id>=<github-deployment-id>` for B7. The CLI inputs are identifiers, not proof. Query the authoritative GitHub API for the configured repository and verify immutable provider responses against the persisted expectation. B6/B9 require the expected head SHA, exact workflow identity, completed/success conclusion, and every named check/job passed. B7 requires a deployment whose ref resolves to the expected osi-server SHA, exact `test` environment, a latest successful deployment status tied to that deployment, and the configured pre-deploy checks. If provider authentication/querying fails or the external process does not publish these facts, remain `awaiting_external`; a local file, URL, or human assertion cannot complete a bundle.

Keep provider mechanics out of `controller.py`. `github_evidence.py` defines an injected `GitHubEvidenceClient` with explicit repository allowlist, token source, connect/read timeout, pagination cap, run/workflow/job queries, deployment/status/ref queries, and no generic URL fetch. Its adapter reads the authoritative objects twice after a bounded consistency delay and requires stable immutable IDs, SHA, workflow/environment, conclusion/status, and job set; a changed/superseded response is retryable evidence absence, not success. It returns only the normalized bounded record below plus a canonical digest of the allowlisted raw fields. Unit tests cover timeout, auth/rate-limit, pagination truncation, wrong repo/SHA/workflow/environment, duplicate/skipped jobs, superseded deployment status, first/second-read drift, malformed provider data, and secret-bearing unexpected fields. Controller tests inject the interface and assert orchestration only.

Normalize the authoritative provider response into strict versioned internal evidence:

```json
{
  "format": 1,
  "bundleId": "B7",
  "executionKind": "external_server",
  "repositories": { "osi-server": "<40-lowercase-hex-sha>" },
  "target": "test",
  "checks": [
    { "name": "backend-tests", "status": "passed", "runId": "<provider-run-id>", "url": "https://github.com/..." }
  ],
  "completedAt": "<UTC ISO-8601>"
}
```

Require exact normalized keys; the current `awaiting_external` bundle ID and execution kind; repository SHAs exactly equal to the previously persisted expectation; target `null` for `external_ci` or exact environment `test` for B7; every required named check exactly once with passed/success state; immutable provider IDs; provider URLs under the configured GitHub repository; and completion after `awaiting_external` began and not in the future. Reject arbitrary files/text, user-supplied SHAs/URLs, unknown/skipped/failed checks, stale or unexpected provider runs, wrong head SHA/workflow/repository/environment, duplicate names/IDs, superseded deployment status, and any provider response that changes across the bounded verification read. Store a SHA256 of the canonical authoritative responses and parsed facts in `ExternalEvidenceRecord`, advance by one, and exit without running the gateway pipeline. On resume, advance only when the stored record still matches the persisted expectation and current bundle requirements. Tests use a fake provider client with negative responses plus valid B6, B7, and B9 cases; no test may satisfy completion by writing a local evidence file.

- [ ] **Step 4: Bind the exact backup, artifact, and release identity to deployment**

Build and locally verify `DeploymentArtifact` before gateway contact. Generate the ID and acquire local/remote locks. Before durable staging, copy only the artifact-owned deployment-state library/CLI, `detect-rpi-profile.sh`, role-stop/rc-quarantine coordinator, and compatibility helper into a volatile root-owned mode-0700 bootstrap directory; verify their independently held hashes, run the detector, require exact `GatewayConfig.profile` agreement, and derive the selected live-control mapping from the post-merge reviewed manifest. Reverify the durable root, exclusively publish the guard-bootstrap intent, execute the reviewed stop/topology-snapshot/rc-quarantine/guard-install sequence, and require the ready `preclaim-inhibit` marker with every stopped/link-absence fact. Only then create the immutable claim binding detected/expected profile, hardware-evidence SHA256, detector SHA256, mapping, and ready-guard generation. Only after claim may the controller create/copy/reverify `/data/osi-deploy/staging/<id>/artifact`; only that staged artifact runs the live-DB audit, backup, and compatibility helper. Intent-before-stop, snapshot-before-link-removal, marker-before-claim, claim-before-staging, detector-swap, config mismatch, old-role-start, and volatile-bootstrap-loss assertions live in real deploy/controller tests. Make `/data/db/backups` the only configured authority and reject Kaba100 drift before SSH.

Extend `backup-pre-deploy.sh` after merge to back up `/data/db`, `/srv/node-red`, GUI/flows/settings, every selected live-control path and exact rc link from the reviewed inventory, guard marker, state/launch/credential/recovery controls, and the exact lstat/head/checkpoint identities of `/data/osi-sync/protocol-capabilities/` plus independent service-owned `/data/osi-sync-witness/{protocol-capability-witnesses,command-activity-witnesses,command-activity-head-witnesses}/`. Because Train B follows accepted Train A, explicit absence is a hard pre-arm failure rather than a fresh-state signal. The deployment artifact separately retains every finalized control candidate. Exclude backup descendants, stop/checkpoint writers, integrity-check/fsync, advance `backup-verified`, and keep stopped. Recovery may compare these evidence copies but must never restore an older chain/database/head, remove a tail/witness/checkpoint, or replace a root with absence. Abandonment verifies unchanged runtime and writes its immutable receipt before release/restart; helpers never bypass startup inhibit.

Emit and strictly parse exactly one each of `LIVE_BACKUP_DIR`, `DATABASE_BACKUP_PATH`, `DEPLOYMENT_ID`, `TARGET_COMMIT_SHA`, `CONTROL_MANIFEST_SHA256`, and `COMPATIBILITY_MANIFEST_SHA256`. Reject missing, duplicate, relative, escaping, group/world-accessible, stale, mismatched, or reused values. The compatibility manifest records the exact source path, type, mode, numeric uid/gid, checksum/link target, deployment ID, target commit, and control-manifest SHA for every required runtime path. Restore and verify ownership as well as bytes/type/mode; use injected ownership adapters in non-root tests. `restore-pre-deploy.sh` consumes that manifest rather than guessing the file set.

Make SQLite restoration a database-set operation, not a main-file copy. With Node-RED stopped and verified absent, checkpoint and close every SQLite handle, validate the replacement image in private storage, and atomically replace `farming.db` on the same filesystem. Quarantine or remove the old `farming.db-wal`, `farming.db-shm`, and `farming.db-journal` before reopening; no sidecar from the failed database may accompany the restored main file. Fsync the replacement file and `/data/db`, reopen it, require `PRAGMA integrity_check='ok'` plus the expected schema fingerprint, and only then report database restoration. If any leg fails, retain the quarantined original set and leave Node-RED stopped. Add a fixture whose stale WAL changes a sentinel row when paired with the restored image; recovery must preserve the restored sentinel, prove all old sidecars are absent from live paths, and fail if a sidecar-cleanup or directory-fsync adapter is skipped.

Inject backup failures after checkpoint, each compatibility-set copy, database copy, manifest fsync, integrity check, and restart; before the manifest completes, remove the incomplete directory, and after completion never relabel it as valid for another attempt. Inject restore failures at stop verification, checkpoint/close, image validation, main replacement, each sidecar quarantine, file/directory fsync, integrity check, and schema-fingerprint verification; none may restart Node-RED.

Only after `BackupResult`, `DeploymentArtifact`, remote lock metadata, persistent lease, and the `backup-verified` gateway journal cross-match may `deploy_to_gateway` invoke the verified remote `deploy.sh`. Use `shlex.quote` for each value and pass `OSI_DEPLOY_MODE=sealed-release`, `OSI_DEPLOY_BACKUP_DIR`, `OSI_DEPLOY_COMMIT_SHA`, `OSI_DEPLOY_ID`, `OSI_DEPLOY_ARTIFACT_DIR`, `OSI_DEPLOY_CONTROL_MANIFEST_SHA256`, and `OSI_DEPLOY_COMPATIBILITY_MANIFEST_SHA256`. Validate bounded value syntax before quoting. Remove the reverse HTTP tunnel and `curl`; no deployment byte comes from the mutable caller worktree or a network fetch. On remote return, fetch and validate the exact `verification-in-flight` state plus immutable deployment receipt before saving the local post-deploy phase; a process crash in between is resolved from that receipt while retaining the lease.

Extend `DeployResult`:

```python
@dataclass
class DeployResult:
    ok: bool
    detail: str
    attempted_stamp: str | None = None
    previous_stamp: str | None = None
    active_stamp: str | None = None
    migration_rollback_class: str | None = None
    migration_pre_backup: str | None = None
    migration_pre_backup_sha256: str | None = None
    migration_pre_backup_size_bytes: int = 0
    deployment_id: str | None = None
    control_manifest_sha256: str | None = None
    compatibility_manifest_sha256: str | None = None
    source_manifest_sha256: str | None = None
    runtime_seal_sha256: str | None = None
    migration_pending_set_sha256: str | None = None
    activation_generation: int = 0
    deployment_receipt_sha256: str | None = None
```

Parse only the anchored `DEPLOY_*` lines above and then fetch the receipt bytes by the exact deployment ID. Reject duplicates, invalid stamp/generation syntax, a nonempty pending-set hash for an empty set or an empty hash for a nonempty set, an unknown or missing migration rollback class, a restore-required class without a verified path/hash/size, a payload-compatible or fresh-database class with nonempty backup identity, fresh-database with any previous stamp, deployment/manifest/selector facts that differ from the artifact, backup, journal, or receipt, success without `active_stamp == attempted_stamp`, a receipt hash mismatch, or failure output claiming an unrelated active stamp. Never infer migration compatibility or completion from exit status or prose.

- [ ] **Step 5: Make recovery a checked operation**

Replace the Boolean-only DB restore call with a coordinator:

```python
@dataclass
class RecoveryResult:
    operation_id: str
    payload_ok: bool
    database_required: bool
    database_ok: bool
    database_restore_protocol_ok: bool
    database_restore_branch: str | None
    database_restore_epoch: int | None
    database_restore_preparation_sha256: str | None
    database_restore_merge_receipt_sha256: str | None
    command_activity_head_sha256: str | None
    capability_head_sha256: str | None
    health_ok: bool
    active_stamp: str | None
    recovery_receipt_sha256: str | None
    topology_activation_receipt_sha256: str | None
    recovery_kind: Literal['ordinary', 'database-integrity'] | None
    integrity_latch_removal_receipt_sha256: str | None
    restored_predecessor: RestoredPredecessorIdentity | None
    restored_predecessor_sha256: str | None
    recovered_generation: int | None
    durable_completed: bool
    detail: str

    @property
    def ok(self) -> bool:
        return (self.payload_ok and
                (not self.database_required or self.database_ok) and
                (not self.database_required or self.database_restore_protocol_ok) and
                self.health_ok and self.durable_completed and
                self.recovery_receipt_sha256 is not None and
                self.topology_activation_receipt_sha256 is not None and
                self.recovery_kind in ('ordinary', 'database-integrity') and
                ((self.recovery_kind == 'database-integrity') ==
                 (self.integrity_latch_removal_receipt_sha256 is not None)) and
                valid_restored_predecessor(self.restored_predecessor,
                                           self.restored_predecessor_sha256) and
                self.recovered_generation is not None)
```

`valid_restored_predecessor` is the shared unknown-field-rejecting codec used by state, CLI, controller, and verifier. For `managed-terminal` it requires the exact predecessor deployment ID and canonical completed/recovered terminal-tuple hash. For `legacy-compatibility` it requires the exact compatibility-manifest, restored-topology, database-identity, and flow-stamp facts proven by the guarded legacy branch; it forbids any synthesized deployment ID or terminal tuple. It canonicalizes the selected object and verifies `restored_predecessor_sha256`.

Before the first remote recovery command, `PipelineState` allocates and fsyncs one `recovery_operation_id` bound to the deployment/receipt and never replaces it on retry. `recover_gateway(gateway, deployment, backup, restore_database, recovery_operation_id)` begins with `status` and handles one closed prefix matrix for the same ID: active sub-operation with neither receipt resumes actions; topology-activation receipt only reverifies it and writes the deterministic recovery receipt; both receipts with the parent still pinned reverifies both plus the discriminated restored-predecessor identity/hash and performs the one final parent CAS; an already-applied `recovered` CAS returns the full terminal tuple. A recovery receipt without its cross-matching topology receipt, reverse-order recovery receipt, mixed receipt/predecessor identity, different active operation/parent, or locally changed ID blocks. Crash tests cover both predecessor kinds, local-ID persistence, remote begin, every action/result generation, each receipt prefix, parent CAS, and returned response.

`recover_gateway(gateway, deployment, backup, restore_database, recovery_operation_id)` must:

1. reconcile the persisted globally one-use recovery operation ID as described above, verify the exact active/resumable sub-operation against the deployment receipt, and only then query the active release;
2. if `deployment.migration_rollback_class == "database-restore-required"`, require `restore_database=true`; require its deployment ID and both manifest hashes to match `backup`; require the migration backup realpath to remain under `backup.live_backup_dir/migrations`, with no symlink component, root ownership/mode 0600, exact recorded size/SHA256, and SQLite integrity immediately before restore; quiesce all four guarded roles, prove every application link inhibited, complete factory lineage invalidation when applicable, require or deterministically complete the immutable post-migration restore baseline from the exact ordered-unit manifest/runner receipt, run the artifact-owned whole-database audit, and invoke `prepare-database-restore` before any SQLite-set mutation. `NO_POST_BACKUP_DATABASE_DELTA` requires backup=baseline=current; `EXPECTED_DEPLOYMENT_MUTATION_ONLY` requires current=baseline plus exact reviewed backup-to-baseline schema/ledger/data delta. Either restores only the exact backup and requires both post-restore audits equal to it. Command-inventory-only post-baseline `RECONCILIATION_REQUIRED` requires the committed invalidation, migration-aware reverse adapters, restore, merge, and typed completion. `REJECTED`, expected-mutation mismatch, post-baseline non-command/unknown delta, unreadable current database, or any missing/failing baseline/helper/result/reconciliation aborts before payload selection;
3. if the class is `payload-compatible`, skip DB restoration regardless of a general deploy backup being available;
4. if the class is `fresh-database`, require no previous stamp and no migration backup, leave Node-RED stopped, remove only an unactivated attempted release/private staging directory, and return a checked non-recoverable result without DB restore or payload selection;
5. roll back the payload only after any required DB restoration succeeds, only if the attempted release is active, and only to `deployment.previous_stamp` recorded by that activation;
6. verify the exact previous release stamp and quarantine the failed attempted stamp;
7. issue the exact one-use `recovery-health` permit only after a no-activity equal post-restore audit or typed `DATABASE_RESTORE_RECONCILED`; for integrity recovery, require integrity reconciled, stopped historical CLEAR, immutable resolution, and `integrity-health-authorized`, consume the integrity permit while the latch and lease remain, run the read-only zero-mutation probe, stop it, and bind its health receipt; and
8. after health, restore/reverify the exact selected release, read-only mount, guard marker, six-link/safety topology, database, ACK audit, and controls while the recovery lease remains active; construct/hash the exact `managed-terminal` predecessor and write/fsync topology-activation first and recovery second. Ordinary recovery may then perform its terminal CAS. Integrity recovery first stable-copies the latch and writes the removal intent bound to both receipts, CASes the existing recovery sub-operation to `integrity-finalizing`, removes/parent-fsyncs the latch, writes the removal receipt, and only then performs the terminal `recovered` CAS. That final CAS records the predecessor plus required receipt hashes, sets lease false, and clears the sub-operation; and
9. return every leg plus operation, database-restore branch/epoch/preparation/merge/activity/capability identities, both recovery receipts, discriminated restored-predecessor object/hash, and generation without converting failure into a warning. Any failure after step 1 CASes `recovery-required` when safe and returns `durable_completed=false`; it never clears the sub-operation or releases ownership.

Step 7 applies to a predecessor whose immutable deployment/acceptance evidence proves the stop-loss ACK contract. A legacy predecessor without that evidence is never connected to live database, credentials, sync HTTP, MQTT, ChirpStack, DNS, or other egress merely to prove health. If the journal proves the new runtime never started, both exact ACK/outbox/domain audits remain unchanged, and the command-activity/capability/writer generations are identical, run retained legacy payload only through the guarded jail; stop it, prove no live change, rerun audit, and restore/verify prior application topology under the permanent inhibitor while safety controls remain fixed. Construct the `legacy-compatibility` predecessor from the exact compatibility-manifest SHA, restored topology SHA, database-identity SHA, and prior flow stamp. Then publish/fsync topology-activation first and recovery second and perform the final parent CAS to terminal `recovered` with that object/hash, both receipt hashes, lease false, and cleared sub-operation. Never invent a managed deployment ID or terminal tuple for this branch. A crash before that CAS follows the same closed two-receipt prefix matrix. If isolation, audit, witness, or topology proof fails, persist `recovery-required` and leave roles stopped. Tests cover both predecessor shapes, cross-kind/extra/missing fields, each legacy hash/stamp tamper, jail escape, live-path substitution, audit/activity drift, topology-only receipt, reverse-order recovery receipt, mixed predecessor/receipt identities, every terminal-CAS crash, and a healthy-looking GUI with unsafe ACK state.

Set `auto_restore_database=true` only for Kaba100. Missing policy defaults to false. No production gateway gets automatic DB restoration from this plan. A restore-required failure on a target without that permission produces `database_required=true`, `database_ok=false`, `payload_ok=false`, `health_ok=false`, and leaves Node-RED stopped; it never performs a payload-only rollback.

The controller uses:

```python
recovery = recover_gateway(
    gateway=target,
    deployment=result,
    backup=backup,
    restore_database=target.auto_restore_database,
    recovery_operation_id=state.in_flight.recovery_operation_id,
)
if not recovery.ok:
    _halt(f"rollback failed: {recovery.detail}", bundle, state,
          status="rollback_failed")
else:
    status = verify_gateway_recovery_receipt(
        operation_id=recovery.operation_id,
        expected_recovery_receipt_sha256=recovery.recovery_receipt_sha256,
        expected_topology_activation_receipt_sha256=recovery.topology_activation_receipt_sha256,
        expected_recovery_kind=recovery.recovery_kind,
        expected_integrity_latch_removal_receipt_sha256=recovery.integrity_latch_removal_receipt_sha256,
        expected_restored_predecessor=recovery.restored_predecessor,
        expected_restored_predecessor_sha256=recovery.restored_predecessor_sha256,
        expected_generation=recovery.recovered_generation,
    )
    if not status.recovered:
        _halt("rollback durable completion mismatch", bundle, state,
              status="rollback_failed")
    _halt(f"verification failed; recovery verified: {failure}", bundle, state,
          status="recovered")
```

`verify_gateway_recovery_receipt` rereads the state generation and independently cross-checks the operation ID, recovery receipt, topology-activation receipt, exact discriminated predecessor object/hash, and terminal `recovered` generation; no single receipt or controller-returned Boolean can satisfy it. Managed and legacy fixtures must reject the other branch's fields. Never emit “restored” before `recovery.ok` is true. The general `backup.database_backup_path` remains live-ops evidence only and is never passed to the automatic restore selector. Add a test with deliberately different valid SQLite contents at the general and migration paths; recovery must restore only the hash-bound `deployment.migration_pre_backup`.

- [ ] **Step 6: Persist recoverable phases and make CLI modes non-destructive**

Replace shallow `__dict__` serialization with exact version-2 encoders/decoders for every nested record. `save_state` writes a mode-0600 temporary file in the same directory, flushes and fsyncs it, atomically replaces the state path, and fsyncs the parent directory. On interruption or corrupt/truncated JSON, preserve the bad bytes for diagnosis and halt; never silently construct a new state.

Persist `in_flight` before and after artifact build, backup, remote deploy, activation result, checks, soak, and recovery. After a bundle completes, atomically persist `current_bundle_idx = i + 1`, clear `in_flight` and `soak_start_epoch`, then emit completion. Resume dispatches from the recorded phase after read-only identity reconciliation; it never starts again at Phase 1 merely because the cursor still names the bundle.

Make CLI modes mutually exclusive. A new local pipeline program is allowed only with no local controller state or exact terminal `completed|recovered` state whose phase-discriminated receipt tuple reverifies through CAS; deleting/truncating state grants nothing. Gateway `arm` independently CAS-replaces the exact terminal tuple. Factory-initializing, in-flight, recovery-required, and every nonterminal state reject new-run/reset. `--resume` requires valid state; external verification modes imply resume. Explicit `--reset-state` performs no pipeline work and refuses live mutation/recovery facts.

`--dry-run` is side-effect-free: use an in-memory/explicit temporary state sink and fake alert/git/provider/network/deploy collaborators, leave the real state bytes unchanged, and never mark the real cursor complete. Add a real-bundle test hashing the state file before/after dry-run and asserting zero alert, git mutation, provider, backup, deploy, SSH, or network calls.

Wrap each external boundary (git, backup, artifact build, deploy, checks, recovery) so `TimeoutExpired`, `CalledProcessError`, `OSError`, and unexpected exceptions persist the appropriate halted/in-flight state and send one urgent alert. `_halt` must set the terminal status and original bounded detail, call `save_state`, and only then attempt the bounded best-effort alert. Alert failure records `last_alert_error` through a second atomic save without changing status, cursor, in-flight recovery facts, or original detail; it never escapes into a path that continues execution. Do not catch `KeyboardInterrupt` or `SystemExit`; the already-fsynced pre-mutation phase makes their next resume deterministic.

Implement the release-selection rehearsal here, before live execution. `restore.py` owns `rehearse_release_selection(gateway, identity, old_candidate, new_candidate, health_check) -> SelectionRehearsalResult`, where each candidate is the exact unknown-field-rejecting `{stamp,sourceManifestSha256,runtimeSealSha256,mountIdentity}` record verified from its release. Before the first selection it uses `begin-rehearsal` to create a linked `operationKind:'selection-rehearsal'` sub-operation in `/data/osi-deploy/deployment-state.json` under the still-active parent deployment lease; do not create `/data/osi-deploy/release-selection-rehearsal.json` or another lock. The bounded state binds parent deployment/receipt hashes, commit/control/compatibility hashes, migration pending-set fingerprint/class, initial/old/new candidate records, selector generation, phase, and the complete last-verified-good candidate. Compare-and-swap and fsync a pre-action phase before every select, issue the matching one-use rehearsal-old or rehearsal-new permit bound to the selected candidate, atomically consume it through the guarded launcher, then record and verify the exact candidate-specific probe result before the next action. Swapped stamp/source/runtime/mount combinations fail before selection or start. Failure reselects only the complete recorded last-verified-good candidate; neither healthy candidate leaves Node-RED stopped and the sub-operation nonterminal. Success verifies the new candidate, writes/fsyncs an immutable rehearsal receipt, then records that receipt hash in both parent gateway state and `PipelineState.in_flight` before returning exact facts. Child-process tests terminate without traps before/after the sub-operation save, both selections, starts, probes, receipt publication, and parent-state update, then run the real resume path. Resume consumes the immutable rehearsal receipt when present and can never infer success from journal absence.

Implement the immutable evidence boundary here as well. `write_evidence_bundle(identity, checks, root)` creates a unique mode-0700 temporary directory under the configured evidence root and accepts exact identity keys: source commit, deployment ID, deployment-receipt hash, rehearsal-receipt hash, gateway, control/compatibility/source/runtime hashes, initial/old/new/final stamps, selector generation, and verification boundary. Each check has a unique allowlisted name, `PASS|FAIL`, timestamp, bounded detail, and evidence file. Reject missing checks or any claim supplied only as prose. Scan filenames and bytes for credential/key/token material, hash every evidence file, write an unknown-field-rejecting `manifest.json` last, set every temporary file to mode 0400 and the temporary directory to 0500, re-lstat and rehash the complete tree, fsync files and directory, atomically rename to an identity-derived non-`latest` path, and fsync the parent. Never chmod after publication. Return only the final manifest path/hash. A partial write never publishes, and crash tests prove no published path is mutable or missing its manifest.

The controller retains the same parent deployment lease plus remote and stable local locks through post-deploy verification, soak, linked selection rehearsal, and evidence publication. After it fsyncs the final evidence identity into local state, it writes/fsyncs the acceptance receipt, advances the gateway and local records to `completed`, and only then releases the persistent lease and remote lock with the original deployment ID plus verified deployment/rehearsal/evidence/acceptance hashes; the local lock is released last. A crash after evidence or acceptance publication resumes idempotently from those hashes; a different deployment cannot interleave a selector change. Tests cover duplicate/missing checks, identity drift, secret sentinels, symlink/special file, mutable latest path, tamper, interrupted write, manifest-before-evidence ordering, pre-rename modes/ownership, rehash validation, and crashes before/after acceptance completion and each final release.

- [ ] **Step 7: Make the controller suite a required CI gate**

Create a focused workflow triggered for pull requests and pushes that affect `scripts/pipeline/**`, `deploy.sh`, release tooling, migrations, or the workflow itself. Use the repository's supported Python version, install only the declared pytest requirements plus `busybox-static`, fail if the BusyBox version probe fails, then run:

```yaml
- name: Run pipeline controller and recovery tests
  run: python -m pytest scripts/pipeline/tests -q
- name: Run executable deploy boundary tests
  run: |
    busybox ash -c 'echo "BUSYBOX_VERSION=$(busybox | head -n 1)"'
    /bin/sh scripts/test-deploy-sh.sh --mode train-a-compat
    busybox ash scripts/test-deploy-sh.sh --mode train-a-compat
    /bin/sh scripts/test-deploy-sh.sh --mode sealed-release
    busybox ash scripts/test-deploy-sh.sh --mode sealed-release
    node scripts/test-ci-guard-wiring.js
```

Do not replace these with collection count, import-only checks, source inspection, or mocked commands that never call `run_pipeline` or the real `deploy.sh`. The suites must contain the every-real-bundle resolver, unauthorized/wrong-target, targetless external-CI, external-server, provider double-read and failure cases, typed-state round trip/tamper, local/remote lock contention, atomic-save interruption, deployment-receipt resume, external-verification-no-reset, dry-run-state-unchanged, every in-flight crash phase, both executable deploy modes and boundary failures, explicit-compatible rollback, undeclared/restore-required blocked rollback, fresh-database no-rollback, Kaba100 DB restore with stale-sidecar protection, rehearsal crash recovery, immutable evidence publication, restore failure, alert failure after persisted halt, exception, and cursor-advance negative controls from Steps 1, 5, and 6.

- [ ] **Step 8: Run and commit the pipeline hardening**

```bash
# First rerun every command in Task 2 Step 8 against the integrated diff.
python -m pytest scripts/pipeline/tests/test_github_evidence.py \
  scripts/pipeline/tests/test_evidence.py -q
python -m pytest scripts/pipeline/tests -q
```

Expected: the suite includes real `run_pipeline` tests and passes the wrong-target, lock-contention, receipt-resume, provider, rollback-failure, rehearsal, evidence, exception, cursor-advance, and no-replay controls.

Create one more dormant review slice before cutover: `feat: add typed pipeline evidence and recovery state` contains the strict state codecs/lock primitive, GitHub adapter, evidence writer, rehearsal/recovery result primitives, and their focused tests. New actions remain unreachable from the normal controller dispatch until the final integration commit. Run the full existing pipeline suite before and after it.

Then make the single runtime cutover commit `fix: seal releases and fail closed at deployment boundaries`. It wires `controller.py`, `deploy.py`, `restore.py`, config/bundles, backup/restore scripts, `deploy.sh`, init/bootstrap, stable links, migration policy, journal/receipt/lock calls, and workflows to the already-green primitives; deletes the Train A-only artifact builder only after its cases have moved one-to-one; and changes no unrelated behavior. Run every Task 2 Step 8 command plus the complete pipeline suite against this integrated diff before committing. The integration diff must show that no new implementation primitive is introduced here except thin wiring; otherwise move it back to a dormant reviewed slice.

Stage each slice by its explicit merged-baseline file list and review cached names. The final slice includes state/CLI, jailed npm and guarded launch tests, mount/credential/deploy tests, settings, every merged profile-control candidate plus selected live-control mapping tests, provider/evidence/rehearsal integration, and Train A builder deletions. Omission fails.

### Task 4: Verify Node-RED runtime configuration end to end on the merged init lifecycle

**Files:**

- Create: `scripts/verify-node-red-runtime-config.js`
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red-runtime-config.sh`
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config`
- Modify: `scripts/test-osi-server-uci-defaults.sh`
- Modify: `.github/workflows/verify-sync-flow.yml`
- Modify: `.claude/skills/osi-config-and-flags/SKILL.md`
- Modify: `docs/operations/edge-history-retention.md`

**Interfaces:**

- Produces: `PROFILE_CONTRACT`, the expected env-to-UCI mapping for every `CHIRPSTACK_PROFILE_*` consumed by maintained flows.
- Produces: `RUNTIME_SETTING_CONTRACT`, the UCI/default/init/export/consumer mapping for every operator-tunable `OSI_*` setting.
- Produces: `RUNTIME_ENV_EXEMPTIONS`, the bounded consumer/preference contract for any discovered `OSI_*` name that intentionally is not UCI/procd-backed.
- Produces: `verifyRuntimeConfig({ bootstrapSource, uciDefaultsSource, runtimeResolverSource, initSource, flows }) -> string[]`, returning errors; an empty array is PASS.

- [ ] **Step 1: Write the contract verifier with negative self-tests**

Use this inventory in one place inside the verifier:

```js
const PROFILE_CONTRACT = Object.freeze([
  { env: 'CHIRPSTACK_PROFILE_KIWI', uci: 'chirpstack_profile_kiwi', local: 'cs_profile_kiwi', consumerIds: ['81c98fb07344a787', '8809bb5239dfb3d4', 'cs-reg-cloud-fn', 'post-devices-insert', 'strega-process-fn'] },
  { env: 'CHIRPSTACK_PROFILE_STREGA', uci: 'chirpstack_profile_strega', local: 'cs_profile_strega', consumerIds: ['8809bb5239dfb3d4', 'cs-reg-cloud-fn', 'post-devices-insert', 'strega-process-fn'] },
  { env: 'CHIRPSTACK_PROFILE_LSN50', uci: 'chirpstack_profile_lsn50', local: 'cs_profile_lsn50', consumerIds: ['8809bb5239dfb3d4', 'cs-reg-cloud-fn', 'lsn50-decode-fn', 'post-devices-insert', 'strega-process-fn'] },
  { env: 'CHIRPSTACK_PROFILE_CLOVER', uci: 'chirpstack_profile_clover', local: 'cs_profile_clover', consumerIds: ['81c98fb07344a787', '8809bb5239dfb3d4', 'cs-reg-cloud-fn', 'post-devices-insert', 'strega-process-fn'] },
  { env: 'CHIRPSTACK_PROFILE_RAK10701', uci: 'chirpstack_profile_rak10701', local: 'cs_profile_rak10701', consumerIds: [], compatibilityAlias: 'bootstrap-only' },
  { env: 'CHIRPSTACK_PROFILE_S2120', uci: 'chirpstack_profile_s2120', local: 'cs_profile_s2120', consumerIds: ['cs-reg-cloud-fn', 'post-devices-insert'] },
  { env: 'CHIRPSTACK_PROFILE_LORAIN', uci: 'chirpstack_profile_lorain', local: 'cs_profile_lorain', consumerIds: ['cs-reg-cloud-fn', 'lorain-process-fn', 'post-devices-insert'] },
  { env: 'CHIRPSTACK_PROFILE_UC512', uci: 'chirpstack_profile_uc512', local: 'cs_profile_uc512', consumerIds: ['6b28e0d879808dd9', 'post-devices-insert'] },
]);

const RUNTIME_SETTING_CONTRACT = Object.freeze([
  { env: 'OSI_OUTBOX_RETENTION_DAYS', uci: 'outbox_retention_days', local: 'outbox_retention_days', defaultValue: '30', min: 1, max: 3650, consumerIds: ['prune-sync-outbox'] },
  { env: 'OSI_OUTBOX_MAX_ROWS', uci: 'outbox_max_rows', local: 'outbox_max_rows', defaultValue: '50000', min: 100, max: 1000000, consumerIds: ['prune-sync-outbox'] },
  { env: 'OSI_HEALTH_RAW_RETENTION_DAYS', uci: 'health_raw_retention_days', local: 'health_raw_retention_days', defaultValue: '14', min: 1, max: 3650, consumerIds: ['gateway-health-rollup-fn'] },
  { env: 'OSI_HEALTH_HOURLY_RETENTION_DAYS', uci: 'health_hourly_retention_days', local: 'health_hourly_retention_days', defaultValue: '365', min: 1, max: 3650, consumerIds: ['gateway-health-rollup-fn'] },
  { env: 'OSI_CLOUD_REST_TIMEOUT_MS', uci: 'cloud_rest_timeout_ms', local: 'cloud_rest_timeout_ms', defaultValue: '30000', min: 1000, max: 120000, consumerIds: ['287c82fcf06bcda4', '9443f279758ee186', 'al-link-server-auth', 'command-ack-http', 'support-delivery-worker', 'sync-bootstrap-http', 'sync-force-build', 'sync-history-http', 'sync-history-manifest-http', 'sync-outbox-http', 'sync-pending-http', 'sync-refresh-http'] },
]);

const RUNTIME_ENV_EXEMPTIONS = Object.freeze([
  {
    env: 'OSI_CLOUD_SERVER_URL',
    consumerIds: ['support-delivery-worker'],
    reason: 'legacy process-only support fallback; linked server URL is persisted in SQLite',
    precedence: ['users.server_url', 'sync_state.server_url', 'env', 'compiled-default'],
  },
]);
```

For every entry require:

- the canonical bootstrap `toUciCloudKey` mapping;
- the bootstrap `envVars` assignment;
- the source release contains `node-red-runtime-config.sh`, whose `resolve_chirpstack_value` implementation reads UCI before the per-key `.chirpstack.env` fallback;
- a `resolve_chirpstack_value osi-server.cloud.<uci> <ENV>` line in `node-red.init`;
- a matching `<ENV>="$<local>"` procd export; and
- the exact sorted maintained flow `consumerIds` set, except RAK10701 where an empty set plus the exact `bootstrap-only` compatibility alias is required.

For every runtime setting require:

- one shared absent-only `set_cloud_default` implementation in both maintained `96_osi_server_config` files and an exact `set_cloud_default <uci> <default>` invocation;
- an exact UCI-first local assignment in `node-red.init` with the same fallback;
- a matching `<ENV>="$<local>"` procd export; and
- an exact discovered `env.get('<ENV>')` consumer-ID set equal to `consumerIds`, with no missing or additional node; and
- one shared integer validator driven by that contract entry's `min`, `max`, and `defaultValue`, with boundary tests for min-1, min, max, max+1, empty, and nonnumeric input.

Discover any `CHIRPSTACK_PROFILE_*` used by flows and fail if it is absent from `PROFILE_CONTRACT` or its exact node-ID set differs. Discover every `env.get('OSI_*')` in both maintained flows and require its name to appear exactly once in the disjoint union of `RUNTIME_SETTING_CONTRACT` and `RUNTIME_ENV_EXEMPTIONS`, with the exact pinned sorted consumer set. For an exemption, require exactly the named function-node IDs and precedence expressions; an exemption cannot suppress another consumer or wildcard. At implementation start, regenerate the inventory from the integrated Train A flows and review any intentional ID change before updating this pin. Add parameterized self-tests that remove each consumer one at a time from every profile, runtime setting, and exemption, plus tests that add one extra consumer; all must produce the exact set-difference error. Also remove the selected-release resolver, invert UCI/env precedence, make `set_cloud_default` unconditional, remove one helper invocation, remove the UC512 export, remove the LoRain UCI mapping, remove the outbox default, remove the REST-timeout export, add a fake `OSI_NEW_SETTING`, omit the server-URL exemption, and add `OSI_CLOUD_SERVER_URL` to a second node. A parse error, unconditional default, absent resolver, absent profile mirror, differing UCI-default mirror, unclassified consumer, unused contract entry, or broadened exemption is failure.

- [ ] **Step 2: Run the verifier and capture the red signal**

```bash
node scripts/verify-node-red-runtime-config.js
```

Expected: FAIL for missing LoRain and UC512 resolve/export lines plus the five absent UCI/init runtime paths. The current `OSI_CLOUD_SERVER_URL` use passes only through its exact one-node exemption.

- [ ] **Step 3: Add the missing profile exports**

Add:

```sh
local cs_profile_lorain=$(resolve_chirpstack_value osi-server.cloud.chirpstack_profile_lorain CHIRPSTACK_PROFILE_LORAIN)
local cs_profile_uc512=$(resolve_chirpstack_value osi-server.cloud.chirpstack_profile_uc512 CHIRPSTACK_PROFILE_UC512)
```

and:

```sh
CHIRPSTACK_PROFILE_LORAIN="$cs_profile_lorain" \
CHIRPSTACK_PROFILE_UC512="$cs_profile_uc512" \
```

Keep UCI first and `.chirpstack.env` as the per-key compatibility fallback through `resolve_chirpstack_value`.

- [ ] **Step 4: Make runtime settings operator-visible without changing defaults**

Add the five values to canonical `96_osi_server_config` as absent-only defaults, mirror the file byte-for-byte, then validate, read, and export them in `node-red.init`. Retention values and row limits must be positive bounded integers; `cloud_rest_timeout_ms` must be an integer from 1000 through 120000. Invalid UCI values log a bounded warning and use the documented default. Do not place unconditional `set` lines for these keys inside the existing batch: a rerun must preserve an operator override.

```sh
set_cloud_default() {
    local key="$1"
    local value="$2"
    uci -q get "osi-server.cloud.$key" >/dev/null 2>&1 || \
        uci set "osi-server.cloud.$key=$value"
}
set_cloud_default lsn50_writer_disable 0
set_cloud_default outbox_retention_days 30
set_cloud_default outbox_max_rows 50000
set_cloud_default health_raw_retention_days 14
set_cloud_default health_hourly_retention_days 365
set_cloud_default cloud_rest_timeout_ms 30000
uci commit osi-server
```

Replace the Train A one-off kill-switch default with the helper call above; its value and verifier remain unchanged. Extend the existing shell-source test so the fake `uci` starts with `lsn50_writer_disable=1`, `outbox_max_rows=75000`, and then invalid timeout values `999`, `120001`, and nonnumeric text. Run the default block twice and prove valid overrides remain, absent keys receive defaults exactly once, and each invalid runtime value exports `30000` without overwriting the operator's stored UCI bytes. Then add the init reads:

```sh
local outbox_retention_days=$(uci -q get osi-server.cloud.outbox_retention_days 2>/dev/null || echo "30")
local outbox_max_rows=$(uci -q get osi-server.cloud.outbox_max_rows 2>/dev/null || echo "50000")
local health_raw_retention_days=$(uci -q get osi-server.cloud.health_raw_retention_days 2>/dev/null || echo "14")
local health_hourly_retention_days=$(uci -q get osi-server.cloud.health_hourly_retention_days 2>/dev/null || echo "365")
local cloud_rest_timeout_ms=$(uci -q get osi-server.cloud.cloud_rest_timeout_ms 2>/dev/null || echo "30000")
```

Validate the locals before `procd_set_param env`, then export the matching five `OSI_*` names. These settings do not belong in `.chirpstack.env`; they are UCI/procd runtime controls. Keep the flow-side defensive fallback values unchanged. Document all five keys, env names, defaults, validation behavior, and consumers in `osi-config-and-flags`; update the retention runbook only for the four retention controls. Document `OSI_CLOUD_SERVER_URL` separately as a non-UCI compatibility fallback whose canonical linked value is SQLite-owned, so operators do not confuse it with `osi-server.cloud.server_host`.

- [ ] **Step 5: Wire the verifier into CI**

Add an explicit workflow step immediately after the sync-flow verifier:

```yaml
- name: Verify Node-RED runtime configuration contract
  run: |
    node scripts/verify-node-red-runtime-config.js
    sh scripts/test-node-red-runtime-config-helper.sh
    sh scripts/test-osi-server-uci-defaults.sh
```

Do not log a source-only “OK” when the verifier cannot parse any source or consumer file. Parse failure is a hard failure. Keep both contracts in this focused script instead of duplicating them in `verify-sync-flow.js`.

- [ ] **Step 6: Run and commit the configuration contract**

```bash
node scripts/verify-node-red-runtime-config.js
node scripts/verify-sync-flow.js
sh scripts/test-node-red-runtime-config-helper.sh
sh -n feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red-runtime-config.sh
sh -n feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init
sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config
sh scripts/test-osi-server-uci-defaults.sh
cmp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config
node .claude/skills/anti-slop-writing/slop-check.js \
  .claude/skills/osi-config-and-flags/SKILL.md docs/operations/edge-history-retention.md
```

```bash
git add scripts/verify-node-red-runtime-config.js \
  feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red-runtime-config.sh \
  feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config \
  scripts/test-osi-server-uci-defaults.sh \
  .github/workflows/verify-sync-flow.yml .claude/skills/osi-config-and-flags/SKILL.md \
  docs/operations/edge-history-retention.md
git commit -m "fix: verify Node-RED runtime configuration"
```

### Task 5: Close CI and GUI contract false greens while preserving merged restart status

**Files:**

- Modify: `.github/workflows/verify-sync-flow.yml`
- Modify: `.github/workflows/typecheck.yml`
- Verify/extend in place: `.github/workflows/migrations.yml`
- Verify/extend in place: `.github/workflows/pipeline.yml`
- Modify/Extend: `scripts/test-ci-guard-wiring.js` (created and already required by Train A Task A0)
- Modify: `web/react-gui/src/services/api.ts`
- Modify: `web/react-gui/src/history/useFeatureFlags.ts`
- Modify: `web/react-gui/tests/historyFeatureFlags.test.ts`
- Verify/Preserve: `web/react-gui/src/App.tsx`
- Verify/Preserve: `web/react-gui/src/components/GatewayRestartBanner.tsx`
- Extend: `web/react-gui/src/components/__tests__/GatewayRestartBanner.test.tsx`
- Verify/Preserve: `web/react-gui/src/hooks/useSystemStatus.ts`
- Verify/Preserve: all seven `web/react-gui/public/locales/{de-CH,en,es,fr,it,lg,pt}/common.json` files

**Interfaces:**

- Extends: `SystemFeatureFlags` with `fieldJournalUxEnabled: boolean`.
- Preserves: `normaliseSystemFeatureFlags(row) -> SystemFeatureFlags` as the only wire-to-domain normalization boundary.
- Requires: a GUI build exists before `analysis-lazy-route.test.ts` runs in CI.
- Preserves: `SystemStats.restartPending` exact `{restartAt:string|null,reason:string,status?:'blocked'|'malformed'|'unreadable'}` shape and `systemAPI.getStats()` passthrough.
- Preserves: exactly one `GatewayRestartBanner` mounted inside `AuthProvider` and above `HashRouter`, plus six `restart` keys in every locale.

- [ ] **Step 1: Add failing feature-flag boundary tests**

Extend the wrapped and legacy fixtures with `fieldJournalUxEnabled` and `field_journal_ux_enabled`. Add focused cases proving `true`, `1`, `'1'`, and `'true'` normalize true, while `false`, missing, null, and unknown strings normalize false. Assert the entire object so omission cannot pass:

```ts
assert.deepEqual(normaliseSystemFeatureFlags({ features: {} }), {
  historyUxEnabled: false,
  historyComparisonEnabled: false,
  historyWorkspacesEnabled: false,
  historyAdvancedOverlaysEnabled: false,
  historyCloudAiEnabled: false,
  fieldJournalUxEnabled: false,
});
```

Run:

```bash
cd web/react-gui && npm run test:unit
```

Expected: FAIL because the service interface and normalizer drop the edge-returned field.

- [ ] **Step 2: Preserve the flag at the service boundary**

Add `fieldJournalUxEnabled` to `SystemFeatureFlags`, normalize camelCase and snake_case alongside the existing flags in `normaliseSystemFeatureFlags`, and add it as `false` in `defaultHistoryFeatureFlags`. Do not normalize API shapes in components or the hook. Do not enable field-journal UI in this task; it only prevents the backend contract from being erased.

- [ ] **Step 3: Make lazy-route bundle enforcement non-skippable in CI**

In `.github/workflows/typecheck.yml`, retain `npm ci` and typecheck, then run:

```yaml
- run: npm run build
- run: npm run test:unit
```

Build failure is a hard failure. The existing unit test may retain its local skip for developer convenience, but CI must always create `build/assets` first. Add a workflow-source negative test or an assertion in the route test that recognizes `CI=true` and fails instead of skipping if assets are absent; this proves future workflow reordering cannot silently restore the false green.

Add executable merged-restart preservation tests before the workflow edit: parse `App.tsx` and require exactly one banner inside `AuthProvider` and before `HashRouter`; exercise `systemAPI.getStats()` with absent, pending, blocked, malformed, and unreadable restart facts without reshaping them; render the banner for those cases; and load all seven locale artifacts, requiring exactly `gateway_identity_change`, `chirpstack_bootstrap`, `account_link`, `account_unlink`, `generic`, and `in_progress`. Remove-one, duplicate-banner, moved-outside-provider, dropped-status, and missing-locale-key mutations fail.

- [ ] **Step 4: Call maintained edge guards explicitly from CI**

Keep one or more named steps in `.github/workflows/verify-sync-flow.yml` whose direct command union is:

```text
node scripts/test-sync-delivery-fail-closed.js
node --expose-gc scripts/test-sync-delivery-fail-closed.js --section trigger-readiness
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sync-protocol-state/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-integrity/index.test.js
node --test scripts/audit-command-ack-state.test.js
node --test scripts/audit-farming-database-state.test.js scripts/seal-database-restore-baseline.test.js scripts/database-integrity-recovery.test.js
node --test scripts/reconcile-command-ack-state.test.js
node scripts/verify-command-activity-witness.js
node --test scripts/sync-protocol-capability-cli.test.js
node scripts/verify-command-ledger-consumers.js
node --test scripts/verify-command-ledger-consumers.test.js
node scripts/test-journal-command-path.js
node scripts/test-journal-lifecycle.js
node scripts/test-journal-api.js
node scripts/test-journal-bootstrap.js
node scripts/verify-helper-registration.js
node --test scripts/verify-helper-registration.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
node --test scripts/test-device-api-auth-status.js
node scripts/verify-sync-http-high-risk-contract.js
node --test scripts/verify-sync-http-high-risk-contract.test.js
node scripts/verify-device-integration.js
node scripts/verify-node-red-runtime-config.js
sh scripts/test-node-red-runtime-config-helper.sh
sh scripts/test-osi-server-uci-defaults.sh
node scripts/verify-agroscope-uplink-transform.js
node scripts/test-sync-outbox-json-guard.js
node scripts/test-flows-wiring.js
node scripts/test-improvement-requests-schema.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-flows-size-ratchet.js
/bin/sh scripts/test-deploy-sh.sh --mode train-a-compat
busybox ash scripts/test-deploy-sh.sh --mode train-a-compat
/bin/sh scripts/test-deploy-sh.sh --mode sealed-release
busybox ash scripts/test-deploy-sh.sh --mode sealed-release
node --test scripts/test-deploy-atomic-payload-wiring.js
sh scripts/test-image-guard-bootstrap.sh
node --test scripts/generate-factory-image-provenance.test.js
node --test scripts/factory-image-provenance-cli.test.js
node scripts/generate-factory-image-provenance.js --check
node scripts/verify-factory-image-provenance.js
node --test scripts/verify-factory-image-provenance.test.js
node --test scripts/verify-built-factory-image-provenance.test.js
sh scripts/test-deployment-inhibit.sh
node --test scripts/verify-profile-parity.test.js
node --test scripts/verify-flows-size-ratchet.test.js
sh scripts/test-gateway-identity-helper.sh
sh scripts/test-osi-identityd.sh
sh scripts/test-identityd-service-lifecycle.sh
node scripts/verify-live-gateway-identity.js
node --test scripts/test-deploy-migration-wiring.js
node scripts/test-journal-bootstrap.js
sh scripts/test-guarded-init-services.sh
busybox ash scripts/test-guarded-init-services.sh
node scripts/test-ci-guard-wiring.js
```

Keep these direct calls even if another aggregate verifier later chains some of them; the workflow is the ownership map for high-risk boundaries. Every script must exit nonzero when its controlled fixture is damaged. Extend `scripts/test-ci-guard-wiring.js` to parse `verify-sync-flow.yml`, `migrations.yml`, `pipeline.yml`, `typecheck.yml`, and `field-journal.yml`, assert each rebased exact command union plus GUI build-before-unit order, and run a table-driven in-memory negative control removing each required command in turn. Add ordering controls for factory seed/audit/protocol-zero before fresh-image ready/CAS, restore preparation before DB restore, BusyBox provisioning before shell tests, the merged lifecycle preconditions before Node-RED/migration work, build before GUI unit tests, and guard execution after every command it owns. Run this guard from `verify-sync-flow.yml`, `migrations.yml`, and `pipeline.yml`. Adding a new source-plan gate requires adding it to the table; a later plan may not replace the union with only its own commands.

For `.github/workflows/migrations.yml`, the same source guard pins the merged release-boundary union named in Task 2 Step 7: builder, real release CLI, safe extractor, deployment-control verifier, personalizer, runtime resolver, release swap, compatibility restore, payload-compatibility test, deployment-state CLI, factory seed/protocol-zero and restore-preparation capability tests, guarded launcher, staged npm, backup/restore, credential publisher, real four-role startup, merged lifecycle tests, executable deploy/wiring, migration-manifest, communication, profile-parity, and absolute flow-size verification. For `.github/workflows/pipeline.yml`, it pins the Task 3 Step 7 union: full `python -m pytest scripts/pipeline/tests -q`, BusyBox version proof, `/bin/sh` and BusyBox executions of both real deploy modes, and the guard itself. Its table-driven negative controls remove each command, factory/preparation ordering edge, and BusyBox provision in turn. A local-only security test is not sufficient.

- [ ] **Step 5: Run and commit the CI/GUI hardening**

```bash
node scripts/test-ci-guard-wiring.js
node scripts/verify-device-integration.js
node scripts/verify-agroscope-uplink-transform.js
node scripts/test-sync-outbox-json-guard.js
node scripts/test-flows-wiring.js
node scripts/test-improvement-requests-schema.js
cd web/react-gui && npm run typecheck && npm run build && npm run test:unit
```

```bash
git add .github/workflows/verify-sync-flow.yml .github/workflows/typecheck.yml \
  .github/workflows/migrations.yml .github/workflows/pipeline.yml \
  scripts/test-ci-guard-wiring.js web/react-gui/src/services/api.ts \
  web/react-gui/src/history/useFeatureFlags.ts web/react-gui/tests/historyFeatureFlags.test.ts \
  web/react-gui/src/App.tsx web/react-gui/src/components/GatewayRestartBanner.tsx \
  web/react-gui/src/components/__tests__/GatewayRestartBanner.test.tsx \
  web/react-gui/src/hooks/useSystemStatus.ts web/react-gui/public/locales/*/common.json
git commit -m "fix: close refactor CI contract gaps"
```

### Task 6: Correct the program record and add durable invariants

**Files:**

- Modify: `docs/architecture/refactor-program-2026.md`
- Modify: `docs/superpowers/specs/2026-07-08-staged-atomic-deploy-design.md`
- Modify: `docs/superpowers/specs/2026-07-10-refactor-execution-engine-design.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Produces: item 5.3 evidence that matches the implemented release unit and rollback rehearsal.
- Produces: repository rules for release compatibility, target resolution, recovery result checking, and UCI-to-process verification.

- [ ] **Step 1: Mark 5.3 partial before implementation evidence exists**

Replace the unconditional “Done” statement with the measured state: flows-only activation exists, while helper/settings/dependency/GUI rollback and controller-triggered payload recovery are incomplete. Cite the original plan's “Known limitation: payload staging scope” trigger and state that multiple extracted helpers have now landed.

- [ ] **Step 2: Update the designs without rewriting history**

Append dated implementation-correction sections. Preserve the original decisions, then record:

```text
The behavior unit is the selected release directory: flows, local helpers,
release-local dependencies, settings, codecs, channel manifest, and GUI.
Mutable credentials, gateway identity, and the farming database remain outside.
One current symlink selects the release. Recovery is successful only after the
selected stamp and bounded health checks are verified.
```

In the execution-engine design, distinguish gateway automation from external server handoff. State that configuration never grants permission to production and that unsupported repo/target pairs halt before mutation.

- [ ] **Step 3: Add compact `AGENTS.md` invariants**

Add near live-deploy and configuration rules:

```text
- Node-RED flows and extracted helper packages are one compatibility unit; deploy and rollback them under one release stamp.
- Build releases from a portable flow template, personalize non-secret site values before sealing, and never mutate the selected release from `node-red.init`.
- Resolve a pipeline bundle's repository and target before git, backup, deploy, or SSH. Never substitute a default gateway.
- Payload-only rollback is allowed only for an unchanged database or a checksum-bound explicit compatibility declaration. Migration risk alone never permits old-payload selection; undeclared and restore-required mutations require the verified pre-mutation DB restore first.
- Before any database replacement, prove no command/effect/ACK activity since the selected backup or append a blocking database-restore generation and reconcile replay/domain evidence before live startup.
- `osi-db-integrity` is read-only at boot; corruption or a valid `.bak-*` requests reviewed leased recovery and never authorizes autonomous quarantine or restore.
- A rollback result is not successful until payload selection, required database policy, and recovery health checks pass.
- A runtime key is wired only when its UCI/default source, node-red.init resolution, procd export, and flow consumer are verified together.
```

- [ ] **Step 4: Run prose checks and commit**

```bash
node .claude/skills/anti-slop-writing/slop-check.js \
  docs/architecture/refactor-program-2026.md \
  docs/superpowers/specs/2026-07-08-staged-atomic-deploy-design.md \
  docs/superpowers/specs/2026-07-10-refactor-execution-engine-design.md \
  AGENTS.md
git diff --check
```

```bash
git add docs/architecture/refactor-program-2026.md \
  docs/superpowers/specs/2026-07-08-staged-atomic-deploy-design.md \
  docs/superpowers/specs/2026-07-10-refactor-execution-engine-design.md AGENTS.md
git commit -m "docs: correct refactor boundary completion evidence"
```

### Task 7: Run release gates and rehearse Kaba100 rollback

**Files:**

- No source changes; this task invokes the rehearsal and evidence implementations already owned, tested, and committed in Task 3.
- Runtime evidence under the existing `pipeline-evidence/` collector.

**Interfaces:**

- Consumes: Tasks 1 through 6 plus the sync stop-loss, writer recovery, ChirpStack reconciliation, and Device API repair plans.
- Produces: one exact commit with local gates, active-release identity, canary evidence, and a reversible Kaba100 release selection.

- [ ] **Step 1: Run the complete local gate set**

```bash
node --test scripts/build-node-red-release.test.js
node --test scripts/node-red-release-cli.test.js
node --test scripts/extract-node-red-release-bundle.test.js
node --test scripts/verify-deployment-control.test.js
node --test scripts/personalize-node-red-release.test.js
sh scripts/test-node-red-runtime-config-helper.sh
node --test scripts/deploy-payload-swap.test.js
node --test scripts/node-red-release-mount.test.js
node --test scripts/deploy-compatibility-set.test.js
node --test scripts/deployment-state-cli.test.js
node --test scripts/node-red-guarded-launch.test.js
sh scripts/pi/run-staged-npm-ci.test.sh
sh scripts/pi/backup-pre-deploy.test.sh
node --test scripts/backup-chirpstack-sqlite.test.js
sh scripts/pi/restore-pre-deploy.test.sh
node --test scripts/flows-credentials-publish.test.js
sh scripts/detect-rpi-profile.test.sh
/bin/sh scripts/test-deploy-sh.sh --mode train-a-compat
busybox ash scripts/test-deploy-sh.sh --mode train-a-compat
/bin/sh scripts/test-deploy-sh.sh --mode sealed-release
busybox ash scripts/test-deploy-sh.sh --mode sealed-release
node --test scripts/test-deploy-atomic-payload-wiring.js
node --test scripts/migrate-cli.test.js
node --test scripts/migration-payload-compatibility.test.js
node --expose-gc scripts/test-sync-delivery-fail-closed.js --section trigger-readiness
node scripts/test-sync-delivery-fail-closed.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sync-protocol-state/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-integrity/index.test.js
node --test scripts/audit-command-ack-state.test.js
node --test scripts/audit-farming-database-state.test.js scripts/seal-database-restore-baseline.test.js scripts/database-integrity-recovery.test.js
node --test scripts/reconcile-command-ack-state.test.js
node scripts/verify-command-activity-witness.js
node --test scripts/sync-protocol-capability-cli.test.js
node scripts/verify-command-ledger-consumers.js
node --test scripts/verify-command-ledger-consumers.test.js
node scripts/test-journal-command-path.js
node scripts/test-journal-lifecycle.js
node scripts/test-journal-api.js
node scripts/test-journal-bootstrap.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-op-parity.js
node scripts/verify-command-safety.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics/index.test.js
node scripts/test-dendro-contract.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
node scripts/verify-helper-registration.js
node --test scripts/verify-helper-registration.test.js
node --test scripts/test-device-api-auth-status.js
node scripts/verify-device-integration.js
node scripts/test-error-recording-flow.js
node scripts/verify-node-red-runtime-config.js
sh scripts/test-osi-server-uci-defaults.sh
node scripts/verify-sync-http-high-risk-contract.js
node --test scripts/verify-sync-http-high-risk-contract.test.js
node scripts/verify-sync-contract.js
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-migrations.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node scripts/verify-agroscope-uplink-transform.js
node scripts/test-sync-outbox-json-guard.js
node scripts/test-flows-wiring.js
node scripts/test-improvement-requests-schema.js
node scripts/test-ci-guard-wiring.js
sh scripts/test-image-guard-bootstrap.sh
node --test scripts/generate-factory-image-provenance.test.js
node --test scripts/factory-image-provenance-cli.test.js
node scripts/generate-factory-image-provenance.js --check
node scripts/verify-factory-image-provenance.js
node --test scripts/verify-factory-image-provenance.test.js
node --test scripts/verify-built-factory-image-provenance.test.js
sh scripts/test-deployment-inhibit.sh
node --test scripts/verify-profile-parity.test.js
node --test scripts/verify-flows-size-ratchet.test.js
sh scripts/test-gateway-identity-helper.sh
sh scripts/test-osi-identityd.sh
sh scripts/test-identityd-service-lifecycle.sh
node scripts/verify-live-gateway-identity.js
node --test scripts/test-deploy-migration-wiring.js
sh scripts/test-guarded-init-services.sh
busybox ash scripts/test-guarded-init-services.sh
node scripts/verify-communication-contract.js
node scripts/verify-profile-parity.js
scripts/check-mqtt-topics.sh
python -m pytest scripts/pipeline/tests -q
sh -n deploy.sh
sh -n scripts/pi/backup-pre-deploy.sh
sh -n scripts/pi/restore-pre-deploy.sh
sh -n feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red-runtime-config.sh
sh -n feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init
(cd web/react-gui && npm run typecheck && npm run build && npm run test:unit)
git diff --check
```

Expected: every command exits 0. The pipeline suite must contain the controller-level wrong-target and rollback-failure cases; a count-only green suite is insufficient.

- [ ] **Step 2: Build and inspect the exact release artifact**

Build the GUI and portable release bundle through `prepare_release_artifact`. Record the commit SHA, deployment-control manifest hash, and release manifest hash. Reverify the complete control artifact, extract a copy locally, run `verifySourceRelease`, and require the writer, DB helper, flow template, settings, and GUI to share that artifact. On Kaba100, reverify the same control-manifest hash, record the non-secret personalization metadata, install release-local `node_modules`, seal the generated `flows.json` plus dependencies, and run `verifyRuntimeRelease` before activation.

- [ ] **Step 3: Take the live-ops backup and deploy only to Kaba100**

At execution time, load `osi-live-ops-runbook`. Record the existing active stamp, Node-RED state, latest five dendrometer timestamps, and `PRAGMA quick_check`. Require that the controller still holds the stable local lock, persistent lease, and exact deployment-ID-bound remote lock acquired before backup; on a resumed process, reclaim only that same parent or a strictly linked sub-operation through journal reconciliation. Require no conflicting state, then use the timestamped `/data/db/backups` backup required by the runbook before changing the release selector. Treat the immutable deployment receipt hash as a hard deploy-leg result while retaining `verification-in-flight`; remote shell exit zero without that receipt is failure, and it is not final program acceptance.

- [ ] **Step 4: Prove one stamp owns the running behavior**

After deploy, require every path below to resolve under the same active release directory:

```sh
readlink -f /srv/node-red/flows.json
readlink -f /srv/node-red/settings.js
readlink -f /srv/node-red/node_modules
readlink -f /srv/node-red/payloads/current/node-red-runtime-config.sh
readlink -f /srv/node-red/chirpstack-bootstrap.js
readlink -f /srv/node-red/osi-device-writer
readlink -f /srv/node-red/osi-db-helper
readlink -f /srv/node-red/codecs
readlink -f /usr/lib/node-red/gui
```

Require Node-RED `running`, `/gui` in `200/301/302`, database quick check `ok`, the writer's async runtime contract, and the Device API status checks from the earlier plans.

Also require `/proc/self/mountinfo` to prove the active release is the exact read-only self-bind target, an attempted write to a disposable sentinel path inside it to fail with `EROFS`, and the Node-RED editor/admin flow-deploy endpoint to be unavailable. Restart `node-red.init`, require the mount to remain or be re-established read-only, and prove `runtime-seal.json`, `flows.json`, `gateway-personalization.json`, one helper, and one GUI asset retain their exact checksums and modes. This is the live proof that startup and runtime administration cannot mutate the selected release.

- [ ] **Step 5: Run the full canary and writer ingest evidence**

From the operator machine, run `deploy-canary-gate.js` with the recorded ISO verification boundary and the test-server admin token. Then run the writer plan's ChirpStack-to-edge correlation window. Both are hard gates.

- [ ] **Step 6: Exercise reversible selection between two known-good releases**

Retain a previous known-good release only when the deploy record classifies the actual previous source-manifest hash as `payload-compatible` for the final database. If the pending set was nonempty, require the exact hash-bound compatibility case from `PAYLOAD_ROLLBACK.json` to have run in CI and recheck that the retained release has that hash. If the actual previous release is restore-required, use a second known-good release whose exact source hash is independently proven compatible with the post-migration schema; otherwise fail/skip the live selection gate and do not close the program item. Never select an unproven payload merely to exercise the mechanism, and do not restore the database during this selection-only rehearsal.

Invoke only Task 3's tested `rehearse_release_selection(...)` controller phase with the exact deployment receipt, composed migration compatibility evidence, and independently verified old/new candidate records containing each stamp, source-manifest hash, runtime-seal hash, and mount identity. Do not implement journal or failure handling in this live task. Require its linked general-state sub-operation, candidate-bound permit and resident swap calls, bounded health probes, last-known-good selection, stop-on-ambiguity behavior, and immutable rehearsal receipt to match the already-green child-process suite. Persist the receipt-bound `SelectionRehearsalResult` into the parent in-flight state and pass those exact facts to the evidence collector; a direct manual swap command cannot satisfy this gate.

- [ ] **Step 7: Validate the closeout evidence without changing the program record**

Keep item 5.3 partial at this checkpoint. Invoke Task 3's tested `write_evidence_bundle(...)`; it is eligible for the evidence-backed documentation task only when the immutable collector records:

```text
one release stamp for flows, helpers, dependencies, settings, codecs, manifest, and GUI
local probe PASS
full canary PASS
ChirpStack-to-edge writer correlation PASS
previous-release selection PASS
new-release reselection PASS
zero fallback markers in the verification window
wrong-target and rollback-failure negative tests PASS
selected-release checksums unchanged across Node-RED restart
explicit-compatible and restore-required migration rollback-policy tests PASS
GUI route-asset test executed without skip
```

After independently rehashing the published evidence and its deployment/rehearsal receipt identities, write/fsync the acceptance receipt, advance the leased gateway operation and local pipeline record to `completed`, verify those terminal bytes, and only then release the persistent lease, remote lock, and stable local lock in that order. A failure before verified acceptance completion invokes the linked recovery path or leaves the operation owned and stopped; it never releases ownership and reports success.

### Task 8: Record live evidence and close item 5.3

**Files:**

- Modify: `docs/architecture/refactor-program-2026.md`

**Interfaces:**

- Consumes: the immutable Task 7 evidence directory and its collector manifest.
- Produces: a reviewable item 5.3 status tied to one source commit, deployment-control hash, source/runtime manifest hashes, deployment ID, old/new stamps, and exact evidence path.

- [ ] **Step 1: Reverify evidence identity**

From a clean checkout of the recorded commit, validate the collector manifest and rehash every referenced evidence file. Require the commit, deployment ID, target gateway name, control/source/runtime hashes, deployment/rehearsal/acceptance receipt hashes, initial/old/new stamps, verification boundary, and each PASS named in Task 7 Step 7. Require the final active stamp to be the recorded new stamp, the general gateway record to be `completed` with `leaseActive:false`, and every receipt to cross-match the evidence identity. Reject mutable “latest” paths, missing files, mismatched hashes, redacted-away pass/fail facts, a nonterminal linked operation, or evidence containing credentials/key material. Raw runtime evidence remains in the existing evidence store and is not added to git.

- [ ] **Step 2: Update only from verified facts**

Change item 5.3 from partial to complete only if Step 1 passes. Record the exact source commit, deployment-control manifest hash, source/runtime manifest hashes, deployment ID, old/new release stamps, immutable evidence path, collector-manifest SHA256, and date. Summarize the local, canary, writer-correlation, restart-immutability, reversible-selection, wrong-target, rollback-failure, migration-policy, and GUI-route results. If any fact is absent or failed, leave 5.3 partial and append the specific missing gate; do not use implementation existence or local CI as a substitute for live evidence.

- [ ] **Step 3: Run prose and diff gates, then commit the evidence-backed record**

```bash
node .claude/skills/anti-slop-writing/slop-check.js \
  docs/architecture/refactor-program-2026.md
git diff --check
git diff -- docs/architecture/refactor-program-2026.md
```

```bash
git add docs/architecture/refactor-program-2026.md
git commit -m "docs: record atomic release rollback evidence"
```

## Exit criteria

This repair extension is complete only when:

- the writer and both normalizers run explicitly in CI against the async-only database contract;
- Kaba100 runs a single versioned behavior release, including its runtime-config resolver and the bootstrap selected by `osi-bootstrap`, and can select the previous release without mixed helper versions;
- the controller cannot route an osi-server bundle to a gateway and cannot report an unverified recovery;
- resume starts at the next unprocessed bundle;
- LoRain and UC512 profiles plus all five operator runtime settings resolve through their documented UCI/init/procd paths, and every other discovered `OSI_*` consumer has a narrow tested exemption;
- `fieldJournalUxEnabled` survives API normalization with an all-false fallback, and the GUI lazy-route guard cannot skip in CI; and
- the refactor program records partial or complete status from current executable evidence rather than the existence of files or tests.
