# `@osi/history-uplot`

This package is the canonical source for the reviewed uPlot history chart, bounded history loader, viewport gestures, and mobile soil-history surface. The prototype and the cloud frontend consume copies or compatibility adapters of this package; authentication, card discovery, source selection, and translations remain host-owned.

The cloud copy must remain byte-identical for every package file, including tests. From the OSI OS checkout, verify a reviewed cloud worktree with:

```bash
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/mobile-soil-history \
  ./scripts/verify-history-uplot-vendor.sh
```

When this package changes, copy the complete directory to the cloud checkout's `frontend/vendor/history-uplot-core`, then run the verifier and both package test suites before updating either integration.

Both host frontends set `install-links=true` in their `.npmrc`. Their lockfiles therefore pack the local package into `node_modules` during `npm ci` and install its uPlot, d3, and type dependencies through the host lockfile. A host clean install must include the package source directory beside the host checkout; it must not depend on a workspace `node_modules` symlink.
