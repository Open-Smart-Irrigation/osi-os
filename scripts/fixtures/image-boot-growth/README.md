# Fstools formatting fixture

`common.c` is unchanged from fstools revision `408c2cc4`, the source pinned
by `openwrt/package/system/fstools/Makefile`. Its original LGPL notice is
preserved. The source archive was verified against `PKG_MIRROR_HASH`.

The policy test applies the production patch, compiles the actual policy
and formatting functions with fake I/O, and checks blank overlays and
recognized ext4/F2FS filesystems. It does not call a real formatter.
