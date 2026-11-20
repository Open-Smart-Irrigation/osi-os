#!/bin/sh
# Sourced by the first-boot partition grow and the early filesystem resize.
# Use only commands present in both images (findmnt/partprobe are not shipped).

osi_rootfs_partition_source() {
  local source expected actual
  source="$(readlink -f "$1")" || return 1
  [ "$source" = /dev/mmcblk0p2 ] && return 0
  [ "$source" = /dev/root ] || return 1
  # /dev/root can be a separate block node, rather than a symlink. Check the
  # mounted device number instead of assuming it denotes this SD partition.
  expected="$(cat /sys/class/block/mmcblk0p2/dev)" || return 1
  [ -n "$expected" ] || return 1
  actual="$(awk -v point="$2" '$5 == point { print $3; exit }' /proc/self/mountinfo)" || return 1
  [ "$actual" = "$expected" ]
}

osi_rootfs_target() {
  local record backing loop offset
  ROOT_FSTYPE=unknown
  record="$(awk '
    $2 == "/overlay" { overlay = $1 " " $3 " " $4 }
    $2 == "/" { root = $1 " " $3 " " $4 }
    END { if (overlay != "") print overlay; else print root }
  ' /proc/mounts)" || return 1
  set -- $record
  [ "$#" -eq 3 ] || return 1
  ROOT_FSTYPE="$2"
  [ "$ROOT_FSTYPE" = ext4 ] || return 1
  case ",$3," in *,rw,*) ;; *) return 1 ;; esac
  ROOT_SRC="$1"
  ROOT_OFFSET=0
  case "$ROOT_SRC" in
  /dev/mmcblk0p2) ;;
  /dev/root)
    osi_rootfs_partition_source "$ROOT_SRC" / || return 1
    ROOT_SRC=/dev/mmcblk0p2
    ;;
  /dev/loop[0-9]*)
    loop="${ROOT_SRC##*/}"
    case "${loop#loop}" in '' | *[!0-9]*) return 1 ;; esac
    backing="$(cat "/sys/class/block/$loop/loop/backing_file")" || return 1
    osi_rootfs_partition_source "$backing" /rom || return 1
    offset="$(cat "/sys/class/block/$loop/loop/offset")" || return 1
    case "$offset" in '' | *[!0-9]* | 0) return 1 ;; esac
    [ "$((offset % 65536))" -eq 0 ] || return 1
    [ "$(cat "/sys/class/block/$loop/loop/sizelimit")" = 0 ] || return 1
    ROOT_OFFSET="$offset"
    ;;
  *) return 1 ;;
  esac
}

osi_rootfs_provisioned() {
  local file
  for file in /data/db/farming.db /data/db/farming.db-wal /data/db/farming.db-shm /data/db/farming.db-journal /etc/osi-bootstrap.done /srv/node-red/flows.json; do
    # Include dangling symlinks and non-regular entries; never open the DB.
    [ -e "$file" ] || [ -L "$file" ] || continue
    return 0
  done
  return 1
}

osi_rootfs_geometry() {
  local entry loop_sectors
  DISK_SECTORS="$(cat /sys/class/block/mmcblk0/size)" || return 1
  PART_START="$(cat /sys/class/block/mmcblk0p2/start)" || return 1
  PART_SECTORS="$(cat /sys/class/block/mmcblk0p2/size)" || return 1
  case "$DISK_SECTORS:$PART_START:$PART_SECTORS" in *[!0-9:]* | :* | *::* | *:) return 1 ;; esac
  [ "$PART_START" -gt 0 ] && [ "$PART_SECTORS" -gt 0 ] || return 1
  [ "$((PART_START + PART_SECTORS))" -le "$DISK_SECTORS" ] || return 1
  case "$ROOT_SRC" in
  /dev/loop*)
    loop_sectors="$(cat "/sys/class/block/${ROOT_SRC##*/}/size")" || return 1
    case "$loop_sectors" in '' | *[!0-9]*) return 1 ;; esac
    [ "$((loop_sectors + ROOT_OFFSET / 512))" -eq "$PART_SECTORS" ] || return 1
    ;;
  esac
  for entry in /sys/class/block/mmcblk0/mmcblk0p*; do
    [ -e "$entry" ] || continue
    case "${entry##*/}" in mmcblk0p1 | mmcblk0p2) ;; *) return 1 ;; esac
  done
}
