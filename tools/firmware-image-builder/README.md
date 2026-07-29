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
