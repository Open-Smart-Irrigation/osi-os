# OSI Firmware Image Builder

This package provides the local API, durable queue, deterministic runner,
verification pipeline, and browser console for building one Raspberry Pi
firmware image per job. It requires Node.js `>=22.5.0`.

Builds use pinned remote commits in detached worktrees. Verified artifacts are
published only beneath registered output roots.

## Verify

Run the complete deterministic gate:

```bash
npm run check
```

The gate includes TypeScript, manifest and migration checks, source policy,
native publisher tests, unit and integration tests, the production UI build,
and desktop and mobile browser tests.

## Install

Install a validated version for the current user:

```bash
npm run install:versioned
```

The outer command runs the complete gate once. Installer core then validates
host capabilities, the digest-qualified builder image, the native publisher,
and the direct execution definition before committing a versioned directory.
The selected version changes only after the complete directory and selection
record have been synced to disk.

The committed fixture lock is intentionally non-installable. Installer core
generates the production lock inside the new version directory only after
builder-image validation succeeds.

Register an approved output root before starting the service:

```bash
npm run configure -- \
  --approved-root /absolute/path/to/images \
  --repository /absolute/path/to/osi-os
```

Configuration prints the canonical install, selection, service, and output
paths before writing. The browser can select only roots already registered by
this command.

## Workstation checks

Run the deterministic prerequisite and release-fixture checks with:

```bash
npm run test:workstation
```

The real-target commands perform builds through the local API. They are
mutating commands, not prerequisite-only guards:

```bash
npm run accept:pi5
npm run accept:pi4
npm run accept:all
```

### Prerequisites

Before invoking a real-target command, install and select a validated package
version, configure an approved output root, and start the user service. The
service must answer on `http://127.0.0.1:43120`.

The command also requires all of the following:

- `OSI_IMAGE_BUILDER_REAL=1`
- `OSI_IMAGE_BUILDER_APPROVED_ROOT_ID` naming a configured approved root
- `OSI_IMAGE_BUILDER_PINNED_SHA` containing the full 40-character source SHA
- `OSI_IMAGE_BUILDER_TARGET=rpi-5` for `accept:pi5`, or `rpi-2` for `accept:pi4`;
  this variable must be unset for `accept:all`
- an SSH `origin` and a matching advertised `main` commit
- the selected installation's generated production lock
- the digest-qualified builder image named by that lock
- the installed native publisher self-test
- Node.js `>=22.5.0`, npm, GCC, libc headers, and `make`
- host Git, `gzip`, and `sha256sum`
- Docker, user systemd, Linux `renameat2`, SQLite, and the configured free-space floor

The configured authorities supply the repository, state root, installation,
and approved output root. Environment variables that name arbitrary filesystem
paths do not replace those authorities. The command rejects an unavailable,
unproven, or changed authority before accepting a result.

### Targets and mutations

`accept:pi5` maps to target ID `rpi-5`. `accept:pi4` maps to target ID `rpi-2`,
the maintained Pi 4/400/3/2 profile. Each command refreshes the local branch
view, runs preflight, enqueues one job, polls that exact job to a terminal
state, and then applies the acceptance checks. Those post-terminal checks
independently verify the published release, write evidence under the job's
state directory, seal the release, and re-open it for a final hash check. Their
failure makes the acceptance command fail; it does not rewrite the job's
terminal state.

`accept:all` runs `rpi-5` first and `rpi-2` second. A failure in the first
target stops the second target. The command exits zero only after both target
results are committed and their builder identity fields agree. There is no
rollback between targets. If Pi 5 succeeds and Pi 4 later fails, the Pi 5 job,
evidence, and published release remain committed.

The build creates a detached source worktree below the configured state root.
It may write job logs, stage evidence, Docker operation evidence, and the
acceptance report there. It publishes only beneath the configured approved
root. It does not modify the source checkout and does not format, flash, or
write a block device.

### Accepted output

Each accepted target directory contains exactly the image, `build-manifest.json`,
`verification.json`, and `sha256sums`. The acceptance report records the source
SHA, job ID, target ID, builder image identity, installed lock hash, manifest
hashes, stage evidence hashes, image digest, image size, image mtime, checksum,
rootfs, database, GUI, configuration, and freshness observations.

The report is stored at:

```text
<state-root>/jobs/<job-id>/evidence/real-acceptance-report.json
```

The release directory is derived from the configured root, branch, source SHA,
and target ID. A failed verification, checksum, gzip test, rootfs check,
authority revalidation, or release seal blocks acceptance-command success.

The real acceptance records in
`test/integration/release-report.md` document two historical target jobs. The
Pi 5 release is published and independently verified but remains writable; the
Pi 4 release is sealed and accepted. Both ran before the current uncommitted
GUI hardening edits in this worktree. Those later edits are not claimed to be
inside either image; each image is source-pinned to the SHA in its report.
