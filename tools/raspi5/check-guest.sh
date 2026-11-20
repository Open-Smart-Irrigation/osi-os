#!/bin/sh
# run.py prepends the guest option assignments before passing this script to sh.
# shellcheck disable=SC2154
set -eu

check_radio() {
    cp /boot/osi-probe /tmp/osi-probe
    chmod +x /tmp/osi-probe
    modprobe spidev
    modprobe i2c-dev
    if [ -n "$bootconf_hash" ]; then
        modprobe gpio-brcmstb
        modprobe spi-bcm2835
        /tmp/osi-probe --boot-flash >/tmp/osi-flash-samples
        echo "$flash_hash  /tmp/osi-flash-samples" | sha256sum -c -
    fi
    if [ "$packets" = 1 ]; then
        /tmp/osi-probe --packets
    else
        /tmp/osi-probe
    fi
}

check_fan() {
    modprobe pwm-rp1
    modprobe pwm-fan
    modprobe bcm2711_thermal
    for dir in /sys/class/hwmon/hwmon*; do
        if [ -f "$dir/name" ] && [ "$(cat "$dir/name")" = pwmfan ]; then
            echo 128 > "$dir/pwm1"
            test "$(cat "$dir/fan1_input")" -gt 2000
            echo 0 > "$dir/pwm1"
            test "$(cat "$dir/fan1_input")" = 0
            cat /sys/class/thermal/thermal_zone0/temp
            return
        fi
    done
    return 1
}

check_usb() {
    i=0
    while [ ! -b /dev/sda ] && [ "$i" -lt 10 ]; do
        sleep 1
        i=$((i + 1))
    done
    test "$(head -c 16 /dev/sda)" = OSI-USB-LOOPBACK
}

check_services() {
    i=0
    while [ "$i" -lt 120 ]; do
        if wget -q -T 3 -O /tmp/osi-gui.html http://127.0.0.1:1880/gui/ &&
           grep -qi '<html' /tmp/osi-gui.html; then
            test -s /data/db/farming.db
            test "$(sqlite3 -readonly /data/db/farming.db 'pragma quick_check')" = ok
            echo 'OSI GUI and gateway database verified'
            return
        fi
        if [ $((i % 10)) = 0 ]; then
            echo "Waiting for the OSI GUI, attempt $((i + 1))"
            if pidof node >/dev/null; then echo 'Node.js process running'; fi
        fi
        sleep 3
        i=$((i + 1))
    done
    logread -e node-red | tail -12 >&2
    echo 'Node-RED did not serve /gui/' >&2
    return 1
}

if [ "$rebooted" = 1 ]; then test "$(cat /etc/osi-reboot-test)" = persisted; fi
if [ "$probe" = 1 ]; then check_radio; fi
if [ "$concentratord" = 1 ]; then sh /boot/osi-test.sh "$packets"; fi
if [ "$ethernet" = 1 ]; then
    ip link set eth0 up
    ip addr add 192.0.2.1/24 dev eth0
    printf '%s%s\n' OSI_ETHERNET_ READY
    ping -I eth0 -c 1 -W 12 192.0.2.2
fi
if [ "$usb" = 1 ]; then check_usb; fi
if [ "$services" = 1 ]; then check_services; fi
check_fan
if [ -n "$bootconf_hash" ]; then
    node=/sys/firmware/devicetree/base/reserved-memory/nvram@0
    test "$(cat "$node/status")" = okay
    expected=$(printf '%016x%08x' 0x38000 "$bootconf_size")
    test "$(hexdump -v -e '1/1 "%02x"' "$node/reg")" = "$expected"
    test -d /sys/bus/platform/devices/38000.nvram
    for dev in /sys/bus/nvmem/devices/*; do
        if [ "$(readlink -f "$dev/of_node")" = "$node" ]; then
            echo "$bootconf_hash  $dev/nvmem" | sha256sum -c -
            break
        fi
    done
fi
test "$(head -c 32 /dev/hwrng | wc -c)" -eq 32
test -c /dev/watchdog
for fn in 1 2; do
    sdio=/sys/bus/sdio/devices/mmc1:0001:$fn
    test "$(cat "$sdio/vendor")" = 0x02d0
    test "$(cat "$sdio/device")" = 0xa9bf
done
echo 'CYW43455 enumerated with two SDIO functions'
test "$(hexdump -v -e '1/1 "%02x"' /proc/device-tree/system/linux,revision)" = "$revision"
awk -v size="$ram_kib" '/^MemTotal:/ { print; valid=($2 > size*0.9 && $2 <= size) } END { exit !valid }' /proc/meminfo
test -r /rom/etc/openwrt_release
test -b /dev/mmcblk0p2
test "$(cat /sys/bus/pci/devices/0000:00:00.0/vendor)" = 0x14e4
test "$(cat /sys/bus/pci/devices/0000:01:00.0/vendor)" = 0x1de4
test "$(cat /sys/bus/pci/devices/0000:01:00.0/device)" = 0x0001
rp1=/sys/bus/pci/devices/0000:01:00.0
test "$(basename "$(readlink "$rp1/driver")")" = rp1
set -- "$rp1"/msi_irqs/*
test "$#" -eq 61
test "$(cat "$1")" = msix
echo 'RP1 driver bound with 61 MSI-X vectors'
ubus call system board
