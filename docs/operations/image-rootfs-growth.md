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
root on partition 2 is also accepted for partition selection and S08 resize.
The automatic reboot covers the shipped squashfs-plus-overlay layout only.
A direct ext4 root has no fstools READY transition; after defaults queues
pending growth, a normal operator restart is required to refresh capacity
and let S08 finish. S96 logs that requirement and does not reboot it. A
different device, read-only mount,
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
including this marker and defaults whiteouts. A visible READY link alone
does not prevent that cleanup.

`S07osi-rootfs-flush` opens an overlay directory descriptor before S08/S10
initialization writes. A small packaged `osi-rootfs-flush` process retains
that descriptor and its kernel writeback-error cursor until S96. S10 checks
that the monitor is available before changing a partition on the shipped
overlay layout. Missing, stopped or mismatched monitors fail closed.

`S95done` performs the existing `mount_root done` transition. The
`S96osi-rootfs-grow-reboot` service requires `readlink /overlay/.fs_state`
to return `2` (READY), then asks the retained descriptor's owner to call
`syncfs(2)`. This flush covers the pending marker, READY directory entry,
defaults whiteouts and other initialization files/directories on that
filesystem. The helper then creates an exclusive private probe under
`/overlay/upper`, writes and fsyncs it, closes and removes it, and fsyncs
the upper directory. A final checked `syncfs` samples the retained error
cursor again. Every operation must succeed before S96 permits the reboot.
Neither service sets `.fs_state` or calls `mount_root done` itself.

Bare BusyBox `sync` cannot report writeback errors. Opening a new descriptor
after a failed writeback can also miss an error already observed elsewhere.
The retained descriptor tracks errors across initialization, including
S95's bare sync. A completed ext4 journal abort can nevertheless escape that
cursor: an earlier commit-record I/O failure need not increment it, and
`syncfs` can return zero once that transaction has ended. The new probe
starts a journal operation and therefore rejects an already-aborted journal,
even while the cached mount and READY link still appear writable. The pinned
kernel's [ext4 journal-handle check](https://github.com/gregkh/linux/blob/v6.6.86/fs/ext4/ext4_jbd2.c#L64)
returns EROFS on this path.

Any flush or probe error poisons the monitor for the rest of the
boot: flush/check/re-arm requests keep failing, both intents remain, and
S96 does not reboot. The monitor cannot silently restart or reset its
cursor on that boot; a stale socket also blocks re-arming. A normal restart
clears this volatile state. This is error detection, not repair of failed
storage. Linux's [writeback error sequence documentation](https://www.kernel.org/doc/html/v6.10/core-api/errseq.html)
explains the cursor model.

The volatile request limits automatic rebooting to the boot that queued
partition growth. A later filesystem-resize failure retains the persistent
marker for a natural boot without requesting another automatic reboot.
A card whose partition already spans the disk skips the partition command
and follows the same READY-gated reboot. Defaults failures return nonzero
so OpenWrt retains the script. An interruption before READY may reset the
uninitialized overlay under fstools' existing protocol; the next mount
restores defaults from ROM and retries against the already enlarged
partition. After READY and a successful complete durability barrier
(checked flush, journal probe and final checked flush), an interruption
preserves the pending marker and whiteouts. That power cycle already
refreshes kernel/loop capacity, so S08 can finish without another automatic
growth reboot. READY alone does not establish persistence.

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

The full-profile init directory contains the S07 writeback monitor,
S08 resize and S96 reboot services,
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
They stub partitioning, filesystem growth and reboot. The lifecycle
regression compiles the pinned fstools cleanup and state functions, runs
real directory cleanup, and exercises the vendored S10 defaults dispatcher,
S95done and the S08/S96 services. It does not emulate a kernel mount or
prove storage behavior during a power cut. The separate writeback test uses
an actual FUSE writeback-cache mount: write(2) succeeds, the later kernel
writeback receives EIO, and bare BusyBox sync returns zero. The packaged
helper's held descriptor reports the error, latches it, and the shipped S96
path refuses reboot. A separate FUSE-stub case simulates a completed journal
abort by returning EROFS on probe creation despite a clean writeback cursor.
It does not inject a real ext4/JBD2 commit-record failure. This is kernel
writeback-path and simulated journal-abort coverage; SD-card power loss and
real journal faults remain TF3 work. TF3 must qualify the final image
pin on disposable larger cards for both Pi 4 and Pi 5:

1. Record image SHA, board, card size, boot links, mount types, partition
   start/size and writable filesystem capacity before growth. Capture
   first-boot logs over a serial console so the automatic reboot is visible.
   Check that the shipped utilities and init enablement match the fixtures.
2. Flash the smaller image onto a larger card. Verify that partition 2 grows,
   its start and partition 1 remain unchanged, and exactly one growth reboot
   occurs after S95done. Record `/overlay/.fs_state` before the requested
   reboot: its symlink target must be `2`. Capture pending state, the
   volatile request and defaults whiteouts at that point. Capture the
   `checked overlay flush and journal probe complete` log separately from
   the first appearance of the READY link. It must follow both checked
   flushes and the successful journal probe.
   Confirm GNU Parted handles the mounted-partition confirmation
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
   on disposable ext4 media before S95, capture them after the complete
   durability barrier, then verify them after the growth reboot and a
   further normal reboot. Collect early
   receipts before application writers change the files.
4. Reboot again and invoke both scripts again. Expect no partition command,
   no growth reboot and no loss of capacity. Repeat with an already full
   partition whose ext4 filesystem is smaller, and with an already grown
   filesystem plus pending state. Both must finish without shrinking.
5. Start both UNKNOWN (missing state link) and PENDING (`1`) cases. Cut
   power before, during and after the partition command; after pending state
   is written but before S95; after the READY link appears but before the
   complete durability barrier finishes; after that barrier but before the
   reboot request; during `resize2fs`;
   after stamp creation; and before pending-state removal. Repeat with an
   already full partition. Capture state links, markers, whiteouts and
   geometry before each cut and after preinit. Before READY, record the
   expected fstools cleanup and defaults restoration. Distinguish visible
   READY from the complete durability barrier: only the latter is a
   durability receipt. After that barrier, require marker/whiteout and canary
   persistence. Each recoverable case must finish
   without an automatic reboot loop. A cut after READY may replace the growth
   reboot after a completed barrier, yielding zero automatic requests. The
   uninterrupted path still requires exactly one on each board.
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
8. Exercise a real storage writeback/flush error on disposable media after
   the READY link appears. Record S07 monitor arming, the kernel I/O error,
   checked flush failure, retained intents and absence of a reboot request.
   A same-boot S96 retry and monitor re-arm must remain refused. A visible
   READY link and a zero exit from bare sync are insufficient receipts.
   Include a one-shot JBD2 commit-record I/O failure during S95's unchecked
   sync, then let the device recover before S96. Capture the journal abort
   and the probe's EROFS/error receipt even if the first checked syncfs returns
   zero. Both intents must remain and no automatic reboot may occur.
9. Inject missing tools, failed marker writes and a full/read-only overlay.
   Expect visible errors, retained retry state and no completion claim.
   Check unsupported backing devices and filesystem types without changing
   those devices. Recheck bootability and filesystem integrity offline after
   interruption cases.

Keep the pin-specific serial logs, geometry and filesystem receipts with
TF3's hardware evidence. IM1 does not claim real-card qualification.
