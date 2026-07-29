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

## Workstation guard

Run the three deterministic workstation and release checks with:

```bash
npm run test:workstation
```

The checks use injected command and filesystem adapters for deterministic
missing-host cases, then exercise the production readers against local
fixtures. Unavailable prerequisites are typed and test fixtures remain
unchanged. Real compiler probes use private temporary directories and return
`mutation: "unknown"` if cleanup or an adapter result cannot prove its mutation
state. Installed selections, release evidence, configuration, and the
publisher are read through held no-follow descriptors with bounded reads and
identity revalidation. Directory checks accept the valid Btrfs `nlink=1`
form.

The real-target commands are guard-only until Task 35 supplies the image-build
execution:

```bash
npm run accept:pi5
npm run accept:pi4
npm run accept:all
```

Each command requires `OSI_IMAGE_BUILDER_REAL=1`, a configured approved-root
ID, and a full pinned source SHA advertised by an SSH `origin` branch.
`accept:pi5` and `accept:pi4` additionally require their exact target.
`accept:all` requires no single-target environment override and validates both
target IDs. All commands require a generated selected installation, exact
Docker RepoDigest, native publisher self-test, Linux `renameat2`, user systemd,
and the configured free-space floor, never below 20 GiB, on both the held
output and state filesystems. The private configured output root cannot overlap
the repository, state, configuration, or installation roots. Proven
read-only failures report no mutation; unproven subprocess or adapter failures
report unknown mutation. A fully satisfied guard still exits nonzero with
`REAL_ACCEPTANCE_NOT_IMPLEMENTED` until the real acceptance task is
implemented.
