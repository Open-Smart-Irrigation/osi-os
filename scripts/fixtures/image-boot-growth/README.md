# Fstools formatting fixture

`common.c` is unchanged from fstools revision `408c2cc4`, the source pinned
by `openwrt/package/system/fstools/Makefile`. Its original LGPL notice is
preserved. The source archive was verified against `PKG_MIRROR_HASH`.

The policy test applies the production patch, compiles the actual policy
and formatting functions with fake I/O, and checks blank overlays and
recognized ext4/F2FS filesystems. It does not call a real formatter.

`overlay-lifecycle.c` preserves the cleanup functions (`handle_rmdir`,
`foreachdir`, `overlay_delete`), state functions (`fs_state_get`,
`fs_state_set`) and state enum from the same pinned source. Only headers
needed by the isolated harness are supplied. The test's preinit driver uses
the UNKNOWN/PENDING/READY branch from `mount_overlay`; the S95 fixture uses
the existing ext4/F2FS `done` transition. Cleanup operates on disposable
upper directories containing markers, whiteout canaries and synthetic data.

The image fixture compiles the actual packaged `osi-rootfs-flush` helper.
It runs S07 before initialization, retains the native descriptor across S95,
and stops the monitor before each simulated power cycle. The volatile socket
uses a short temporary path to stay within Unix socket path limits.

`writeback-fuse.c` is a disposable kernel writeback-cache filesystem for the
separate writeback regression. Its writeback callback returns EIO after a
successful cached write. The test runs the actual packaged helper and S96,
including a successful bare BusyBox sync before the checked flush. FUSE is
required in CI; the test does not skip or substitute a shell error stub.
