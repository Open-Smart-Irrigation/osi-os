# Image filesystem growth

A fresh OSI image grows partition 2 of the SD card on first boot, then grows
its writable ext4 filesystem on the next boot. Both full image profiles ship
the same scripts. This path supports the image's MBR layout on `mmcblk0`;
it preserves the partition start and the boot partition.

## Image policy and shipped paths

The osi-os lead approved ext4 for newly formatted full-image overlays on
20 November 2026. `CONFIG_FSTOOLS_ROOTDISK_EXT4=y` selects this policy in
both full image configs. It changes fstools' choice only for an unformatted
or factory-reset overlay. An existing ext4 or F2FS filesystem bypasses the
formatting branch. There is no conversion or reformat of existing media.
The F2FS module package remains disabled.

Before this pin, shipped images can create F2FS. Both Pi subtarget kernel
configs enable built-in `CONFIG_F2FS_FS=y`; disabling the separate
`kmod-fs-f2fs` package does not disable that built-in support. The pinned
fstools revision `408c2cc4` chooses F2FS above 100 MiB. The full profiles
allocate a 14 GiB root partition, leaving well over that threshold after
squashfs. An existing ext4 overlay is reused, and a blank overlay at or
below the threshold takes ext4 instead.

The retained v0.8.0, v0.8.1 and v0.8.2 image build trees contain this same
fstools policy and generated Pi 4 and Pi 5 kernels with F2FS built in.
Their squashfs artifacts are about 68 MiB on Pi 4 and 73 MiB on Pi 5,
leaving over 13 GiB for the fresh overlay. Thus the normal blank-card path
of those images formats F2FS. Existing gateways may already use it. These
are source and retained-build findings; IM1 did not inspect a live gateway.

The new image uses squashfs with an ext4 overlay on a loop device. The shared
`usr/libexec/osi-rootfs-grow.sh` helper reads the mounted filesystem from
`/proc/mounts`, checks its loop backing device and offset through sysfs, and
checks `/dev/root` aliases against the mounted device number. A direct ext4
root on partition 2 is also accepted. A different device, read-only mount,
non-ext4 filesystem, bounded loop device or extra partition is refused.
Existing F2FS media returns a logged no-op, visible under the
`osi-rootfs-grow` tag in `logread`, and keeps any pending marker untouched.
Neither image supplies `findmnt` or `partprobe`; the scripts require neither.

## Dispatch and retry state

OpenWrt's `rc.common` treats any nonempty `USE_PROCD` as enabled. Setting it
to `0` replaces a script's `start()` with a procd wrapper, which calls
`start_service()`. The filesystem service clears the variable so `boot`
and `start` reach its own resize function.

`90_osi_rootfs_grow` runs through OpenWrt's sourced uci-defaults dispatcher.
It extends partition 2 only while there is no farm database, database
sidecar, bootstrap stamp or seeded runtime flows file. These are existence
checks; the scripts never open or modify `farming.db` or its sidecars.
A provisioned gateway without pending growth is left alone.

After partition growth, the defaults script persists
`/etc/osi-rootfs-grow-needs-resize` and queues a volatile
`/var/run/osi-rootfs-grow-reboot` request. It does not reboot from S10.
Fstools can erase an UNKNOWN/PENDING overlay on the next preinit mount,
including this marker and defaults whiteouts. Sync alone does not prevent
that cleanup.

`S95done` performs the existing `mount_root done` transition. The new
`S96osi-rootfs-grow-reboot` service accepts the queued request only when
`readlink /overlay/.fs_state` returns `2` (READY). It syncs that state and
the pending marker before requesting the growth reboot. It never sets
`.fs_state` or calls `mount_root done` itself. This preserves fstools'
initialization protocol and leaves failed readiness visible without forcing
unrelated provisioning to succeed.

The volatile request limits automatic rebooting to the boot that queued
partition growth. A later filesystem-resize failure retains the persistent
marker for a natural boot without requesting another automatic reboot.
A card whose partition already spans the disk skips the partition command
and follows the same READY-gated reboot. Defaults failures return nonzero
so OpenWrt retains the script. An interruption before READY may reset the
uninitialized overlay under fstools' existing protocol; the next mount
restores defaults from ROM and retries against the already enlarged
partition. An interruption after READY preserves the pending marker and
whiteouts. That power cycle already refreshes kernel/loop capacity, so S08
can finish without another automatic growth reboot.

If provisioning proceeds after a partition-step failure without pending
state, a later run refuses partition changes and requires operator
diagnosis. Growth never changes the partition start.

The early `S08osi-rootfs-resize` pass only runs with pending state. It checks
that the kernel sees the full partition and that any overlay loop covers
that partition after its squashfs offset. It then runs online ext4 growth.
This pass can complete after provisioning has started; it does not
repartition, stop services, unmount filesystems or access application files.
A rerun against an already grown filesystem is harmless.

On success, the service writes `/etc/osi-rootfs-grow.partitioned`, syncs it,
then removes pending state. Failures preserve the pending marker. A cut
after filesystem growth or stamp creation can repeat `resize2fs`. If both
markers survive, pending state takes precedence in the service. A stale
kernel partition size requires a reboot before the filesystem pass can
complete. If an interrupted partition command leaves unreadable geometry,
the scripts refuse further work; preserve the card for diagnosis.

## Boot-script audit and IM2 handoff

The full-profile init directory contains the growth service,
`osi-bootstrap`, `osi-identityd`, Redis and `osi-db-integrity`. Bootstrap
uses `start()` without procd; identityd and Redis use procd with
`start_service()`. The remaining uci-defaults files execute their setup
commands directly when sourced. No other instance of the dispatch defect
was found in those scripts or the shipped feed init scripts.

`osi-db-integrity` still has `USE_PROCD=0` (issue #637 NEW-16). Leave it
inert until IM2 replaces the unsafe startup doctor. Its Node-to-logger
pipeline would also hide Node's failure status if enabled. IM1 does not
change this service or its database helper.

## TF3 real-card qualification

Shell fixtures establish dispatch, command selection and retry behavior.
They stub partitioning, filesystem growth, sync and reboot. The lifecycle
regression compiles the pinned fstools cleanup and state functions, runs
real directory cleanup, and exercises the vendored S10 defaults dispatcher,
S95done and the S08/S96 services. It does not emulate a kernel mount or
prove storage behavior during a power cut. TF3 must qualify the final image
pin on disposable larger cards for both Pi 4 and Pi 5:

1. Record image SHA, board, card size, boot links, mount types, partition
   start/size and writable filesystem capacity before growth. Capture
   first-boot logs over a serial console so the automatic reboot is visible.
   Check that the shipped utilities and init enablement match the fixtures.
2. Flash the smaller image onto a larger card. Verify that partition 2 grows,
   its start and partition 1 remain unchanged, and exactly one growth reboot
   occurs after S95done. Record `/overlay/.fs_state` before the requested
   reboot: its symlink target must be `2`. Capture pending state, the
   volatile request and defaults whiteouts at that point. Confirm GNU Parted handles the mounted-partition confirmation
   with the image's actual package version.
3. Use disposable-image serial/preinit tracing to capture `.fs_state`, the
   pending marker and defaults whiteouts after the next preinit mount and
   before S08. READY and both persistent artifacts must survive; the volatile
   request must be absent. Confirm S08 consumes the marker, S10 does not
   repartition or requeue, and S96 does not request another reboot.
   After the next boot, measure partition sectors, overlay loop offset and
   capacity, and ext4 capacity independently. Allow for the squashfs offset
   and ext4 metadata. Check that pending state is gone, the completion stamp
   exists and available writable capacity has increased. Exercise writes
   beyond the original filesystem boundary. As an explicit persistence case,
   place known configuration/data canaries and synthetic application rows
   on disposable ext4 media before S95, capture them after READY, then verify
   them after the growth reboot and a further normal reboot. Collect early
   receipts before application writers change the files.
4. Reboot again and invoke both scripts again. Expect no partition command,
   no growth reboot and no loss of capacity. Repeat with an already full
   partition whose ext4 filesystem is smaller, and with an already grown
   filesystem plus pending state. Both must finish without shrinking.
5. Start both UNKNOWN (missing state link) and PENDING (`1`) cases. Cut
   power before, during and after the partition command; after pending state
   is written but before S95; after READY but before S96; during `resize2fs`;
   after stamp creation; and before pending-state removal. Repeat with an
   already full partition. Capture state links, markers, whiteouts and
   geometry before each cut and after preinit. Before READY, record the
   expected fstools cleanup and defaults restoration. After READY, require
   marker/whiteout and canary persistence. Each recoverable case must finish
   without an automatic reboot loop. A cut after READY may replace the growth
   reboot, yielding zero automatic requests; the uninterrupted path still
   requires exactly one on each board.
   Preserve any unreadable card and stop qualification on a failed recovery.
6. On disposable provisioned media, verify that first-boot partition growth
   is refused, including when only a database sidecar survives. Separately
   qualify pending online ext4 growth during synthetic SQLite WAL writes:
   preserve baseline rows and sidecars, then verify committed rows and
   database integrity after reboot. Confirm the scripts issue no database,
   reseed, unmount or service-stop command. No production farm is a test rig.
7. As an explicit disposable-media case, boot an existing F2FS overlay to
   READY with synthetic database/configuration canaries and any prepared
   pending marker. Invoke defaults, S08 and S96, including a prepared volatile
   request. Require an F2FS no-op message in `logread`, no automatic reboot,
   and unchanged filesystem type, partition geometry, capacity and persistent
   contents. Reboot normally and verify the same canaries and pending state
   persist. No formatter, conversion or filesystem-growth command may run.
8. Inject missing tools, failed marker writes and a full/read-only overlay.
   Expect visible errors, retained retry state and no completion claim.
   Check unsupported backing devices and filesystem types without changing
   those devices. Recheck bootability and filesystem integrity offline after
   interruption cases.

Keep the pin-specific serial logs, geometry and filesystem receipts with
TF3's hardware evidence. IM1 does not claim real-card qualification.
